// The ChatGPT→Claude handoff is only the running example. Nothing in the server
// knows about vendors: every direction and every pairing must behave the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

test('handoff works in every direction and pairing, over either auth style', async (t) => {
  const { server, messenger: m } = createApp();
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://localhost:${server.address().port}`;
  const owner = m.authenticate(m.registerHuman({ handle: 'alice' }).token);

  // Two agents per runtime; "url" = token in path (ChatGPT style), "header" = Bearer (Claude Code style).
  const agents = {};
  for (const [handle, runtime, auth] of [
    ['gpt_a', 'chatgpt', 'url'], ['gpt_b', 'chatgpt', 'url'],
    ['claude_a', 'claude-code', 'header'], ['claude_b', 'claude-code', 'header'],
  ]) {
    const { token } = m.createAgent(owner, { handle, runtime });
    let id = 0;
    agents[handle] = async (name, args = {}) => {
      const res = await fetch(auth === 'url' ? `${base}/mcp/${token}` : `${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth === 'header' && { authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      });
      const { result } = await res.json();
      assert.equal(result.isError, undefined, `${handle}.${name}: ${result.content[0].text}`);
      return JSON.parse(result.content[0].text);
    };
  }

  const pairs = [
    ['gpt_a', 'claude_a'], // the usual example
    ['claude_a', 'gpt_a'], // reverse
    ['gpt_a', 'gpt_b'], // ChatGPT ↔ ChatGPT
    ['claude_a', 'claude_b'], // Claude ↔ Claude
    ['claude_b', 'gpt_b'],
  ];
  for (const [from, to] of pairs) {
    const send = agents[from], recv = agents[to];
    const goal = `work from ${from} to ${to}`;
    const { context, follow_up } = await send('share_context', { to: `@${to}`, task_goal: goal, artifacts: [{ title: 'doc', content: goal }] });
    assert.ok(follow_up, 'sender gets the follow-up hint whatever its runtime');
    const { task } = await send('delegate_task', { to: `@${to}`, title: goal, context_id: context.context_id });

    const inbox = await recv('get_inbox');
    const mine = inbox.messages.filter((x) => x.sender.handle === from);
    assert.deepEqual(mine.map((x) => x.kind), ['context', 'task'], `${from}→${to} delivery`);
    assert.equal((await recv('get_context', { context_id: context.context_id })).artifacts[0].content, goal);
    await recv('update_task', { task_id: task.task_id, status: 'completed', result: `done by ${to}` });
    await recv('ack_messages', { message_ids: mine.map((x) => x.id) });

    const back = await send('get_inbox');
    const reply = back.messages.find((x) => x.task?.task_id === task.task_id);
    assert.equal(reply.task.result, `done by ${to}`, `${to}→${from} result`);
    await send('ack_messages', { message_ids: back.messages.map((x) => x.id) });
  }

  // Third parties never saw any of it.
  assert.equal((await agents.claude_b('get_inbox')).count, 0);
  assert.equal((await agents.gpt_b('get_inbox')).count, 0);
});

test('agents of DIFFERENT owners: same-vendor and cross-vendor pairs, gated by owner approval', async (t) => {
  const { server, messenger: m } = createApp();
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://localhost:${server.address().port}`;

  const humans = {}, agents = {};
  const client = (token, auth) => {
    let id = 0;
    return async (name, args = {}) => {
      const res = await fetch(auth === 'url' ? `${base}/mcp/${token}` : `${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth === 'header' && { authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      });
      const { result } = await res.json();
      return { data: JSON.parse(result.content[0].text), isError: !!result.isError };
    };
  };
  for (const h of ['alice', 'bob', 'carol']) {
    const { token } = m.registerHuman({ handle: h });
    humans[h] = { token, principal: m.authenticate(token) };
    for (const [kind, runtime, auth] of [['gpt', 'chatgpt', 'url'], ['claude', 'claude-code', 'header']]) {
      const handle = `${h}_${kind}`;
      agents[handle] = client(m.createAgent(humans[h].principal, { handle, runtime }).token, auth);
    }
  }
  const rest = async (method, path, token, body) => (await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body && JSON.stringify(body),
  })).json();

  // Before approval nothing crosses the owner boundary, in any pairing.
  const first = await agents.alice_gpt('share_context', { to: '@bob_gpt', task_goal: 'x' });
  assert.equal(first.isError, true);
  assert.equal(first.data.error, 'approval_required');
  assert.equal((await agents.bob_gpt('get_inbox')).data.count, 0);
  // An agent cannot approve on its owner's behalf; only bob (the human) can.
  const [request] = await rest('GET', '/api/contacts', humans.bob.token);
  assert.equal(request.direction, 'incoming');
  assert.equal(request.requested_by, 'alice_gpt');
  await rest('POST', `/api/contacts/${request.id}/decision`, humans.bob.token, { accept: true });

  // One approval between the two owners covers all four pairings, both directions.
  for (const [from, to] of [
    ['alice_gpt', 'bob_gpt'], // A's ChatGPT → B's ChatGPT
    ['bob_claude', 'alice_claude'], // B's Claude → A's Claude
    ['alice_claude', 'bob_gpt'], // cross-vendor
    ['bob_gpt', 'alice_gpt'], // reverse
  ]) {
    const send = agents[from], recv = agents[to];
    const goal = `${from} to ${to}`;
    const shared = await send('share_context', { to: `@${to}`, task_goal: goal });
    assert.equal(shared.isError, false, `${goal}: ${JSON.stringify(shared.data)}`);
    const ctx = shared.data.context.context_id;
    const { data: { task } } = await send('delegate_task', { to: `@${to}`, title: goal, context_id: ctx });
    const inbox = (await recv('get_inbox')).data.messages.filter((x) => x.sender.handle === from);
    assert.deepEqual(inbox.map((x) => x.kind), ['context', 'task'], goal);
    assert.equal((await recv('get_context', { context_id: ctx })).data.task_goal, goal);
    await recv('update_task', { task_id: task.task_id, status: 'completed', result: `done by ${to}` });
    await recv('ack_messages', { message_ids: inbox.map((x) => x.id) });
    const back = (await send('get_inbox')).data.messages;
    assert.equal(back.find((x) => x.task?.task_id === task.task_id).task.result, `done by ${to}`);
    await send('ack_messages', { message_ids: back.map((x) => x.id) });

    // The recipient owner's OTHER agent was not named, so it cannot read the package.
    const sibling = to.endsWith('_gpt') ? to.replace('_gpt', '_claude') : to.replace('_claude', '_gpt');
    assert.equal((await agents[sibling]('get_context', { context_id: ctx })).data.error, 'forbidden');
    // Both owners can audit the exchange; an unrelated owner cannot see it at all.
    const [o1, o2] = [from, to].map((h) => humans[h.split('_')[0]]);
    for (const o of [o1, o2]) assert.equal((await rest('GET', `/api/contexts/${ctx}`, o.token)).task_goal, goal);
    assert.equal((await rest('GET', `/api/contexts/${ctx}`, humans.carol.token)).error, 'forbidden');
    assert.equal((await rest('GET', `/api/conversations/${task.conversation_id}/messages`, humans.carol.token)).error, 'forbidden');
  }

  // Approval is per owner pair: carol's agents are still locked out of both.
  assert.equal((await agents.carol_gpt('send_message', { to: '@alice_gpt', text: 'hi' })).data.error, 'approval_required');
  assert.equal((await agents.carol_claude('send_message', { to: '@bob_claude', text: 'hi' })).data.error, 'approval_required');
  // Each owner's audit log shows the other side reading their packages.
  const audit = await rest('GET', '/api/audit?limit=500', humans.alice.token);
  assert.ok(audit.some((a) => a.action === 'context.read' && a.actor === 'bob_gpt'));
  assert.ok(audit.some((a) => a.action === 'context.read_denied' && a.actor === 'carol'));
});
