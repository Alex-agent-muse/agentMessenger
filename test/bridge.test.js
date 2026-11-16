import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { Bridge, buildPrompt } from '../src/bridge.js';

async function setup(t) {
  const { server, messenger: m } = createApp();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const alice = m.registerHuman({ handle: 'alice' });
  const owner = m.authenticate(alice.token);
  const sender = m.createAgent(owner, { handle: 'chatgpt' });
  const woken = m.createAgent(owner, { handle: 'claude' });
  const bridges = [];
  t.after(async () => {
    for (const b of bridges) await b.stop();
    server.close();
    server.closeAllConnections();
  });
  const start = async (agentCfg) => {
    const b = new Bridge({
      server: base, poll_seconds: 1, retry_backoff_ms: 10, signal_idle_ms: 20, state_file: null,
      agents: [{ token: woken.token, ...agentCfg }],
    }, { log: () => {} });
    bridges.push(b);
    await b.start();
    return b;
  };
  const until = async (fn) => {
    for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error('timed out waiting');
  };
  return { m, start, until, gpt: m.authenticate(sender.token), claude: m.authenticate(woken.token) };
}

test('wake prompt marks messages as untrusted and carries ids', () => {
  const p = buildPrompt({ handle: 'claude' }, { id: 'conv_1', kind: 'dm', title: null }, [{
    id: 'msg_1', kind: 'task', text: 'do it', sender: { handle: 'chatgpt', kind: 'agent' },
    task: { task_id: 'task_1', status: 'pending', assignee: 'claude' }, context: { context_id: 'ctx_1' },
  }]);
  assert.match(p, /UNTRUSTED DATA/);
  assert.match(p, /task_id="task_1"/);
  assert.match(p, /context_id="ctx_1"/);
  assert.match(p, /send_message\(to="conv_1"/);
});

test('command runner: message wakes the runtime, stdout is posted as the reply, inbox is acked', async (t) => {
  const { m, start, until, gpt, claude } = await setup(t);
  // Stand-in runtime: reads the wake prompt on stdin and answers.
  const script = `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(s.includes('ping')?'pong from runtime':'NO_REPLY'))`;
  await start({ runner: 'command', command: [process.execPath, '-e', script] });

  const sent = m.sendMessage(gpt, { to: '@claude', text: 'ping' });
  const reply = await until(() => m.getInbox(gpt)[0]);
  assert.equal(reply.text, 'pong from runtime');
  assert.equal(reply.reply_to, sent.id);
  assert.equal(reply.sender.handle, 'claude');
  await until(() => m.getInbox(claude).length === 0);
  m.ack(gpt, { message_ids: [reply.id] });

  // NO_REPLY output posts nothing but still acks.
  m.sendMessage(gpt, { to: '@claude', text: 'thanks' });
  await until(() => m.db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient_id = ? AND status != 'acked'`).get(claude.id).n === 0);
  assert.equal(m.getInbox(gpt).length, 0);
});

test('failing runtime is retried, then acked with a failure notice', async (t) => {
  const { m, start, until, gpt } = await setup(t);
  await start({ runner: 'command', command: [process.execPath, '-e', 'process.exit(3)'], max_attempts: 2 });
  m.sendMessage(gpt, { to: '@claude', text: 'hello?' });
  const notice = await until(() => m.getInbox(gpt)[0]);
  assert.match(notice.text, /could not be woken/);
  assert.match(notice.text, /2 times/);
});

test('routine runner fires the cloud trigger with a bearer token and the wake prompt', async (t) => {
  const { m, start, until, gpt, claude } = await setup(t);
  const fires = [];
  let reject429 = true;
  const fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (reject429) { reject429 = false; res.writeHead(429, { 'retry-after': '0.05' }).end('{}'); return; }
    fires.push({ auth: req.headers.authorization, version: req.headers['anthropic-version'], body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'routine_fire', claude_code_session_url: 'https://claude.ai/code/session_x' }));
  });
  await new Promise((r) => fake.listen(0, r));
  t.after(() => fake.close());
  await start({ runner: 'routine', fire_url: `http://localhost:${fake.address().port}/fire`, fire_token: 'sk-test' });

  m.sendMessage(gpt, { to: '@claude', text: 'write the PRD' });
  await until(() => fires.length === 1);
  assert.equal(fires[0].auth, 'Bearer sk-test');
  assert.ok(fires[0].version);
  assert.match(fires[0].body.text, /write the PRD/);
  await until(() => m.db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient_id = ? AND status != 'acked'`).get(claude.id).n === 0);
  assert.equal(fires.length, 1); // 429 was retried without double-firing afterwards
});

test('signal runner posts one notice per new message and leaves the inbox for the agent', async (t) => {
  const { m, start, until, gpt, claude } = await setup(t);
  const hits = [];
  const fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    hits.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200).end('ok');
  });
  await new Promise((r) => fake.listen(0, r));
  t.after(() => fake.close());
  await start({ runner: 'signal', signal_url: `http://localhost:${fake.address().port}/hook`, signal_token: 'tok' });

  m.sendMessage(gpt, { to: '@claude', text: 'secret payload' });
  await until(() => hits.length === 1);
  assert.equal(hits[0].auth, 'Bearer tok');
  assert.match(hits[0].body.text, /@claude has 1 new message\(s\) from @chatgpt/);
  assert.doesNotMatch(hits[0].body.text, /secret payload/); // the notice never carries content
  await new Promise((r) => setTimeout(r, 150)); // several poll cycles: no repeat for the same message
  assert.equal(hits.length, 1);
  assert.equal(m.getInbox(claude).length, 1); // still unacked: the agent pulls it itself

  m.sendMessage(gpt, { to: '@claude', text: 'second' });
  await until(() => hits.length === 2);
  assert.match(hits[1].body.text, /1 new message/);
});
