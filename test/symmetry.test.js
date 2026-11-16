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
