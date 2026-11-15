// End-to-end demo over real HTTP + MCP: "ChatGPT" hands research to "Claude"
// with zero file export, Claude delivers a PRD back. Both sides are simulated
// MCP clients here; real ChatGPT / Claude Code connect to the same endpoints.
import { createApp } from '../src/server.js';

const { server } = createApp({ dbPath: ':memory:' });
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const rest = async (path, token, body) => (await fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body),
})).json();

let id = 0;
const mcpClient = (label, url, headers = {}) => async (name, args = {}) => {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const { result } = await res.json();
  const data = JSON.parse(result.content[0].text);
  console.log(`\n[${label}] ${name}(${JSON.stringify(args).slice(0, 110)}…)${result.isError ? '  ✗ ' + data.message : ''}`);
  return data;
};

const alice = await rest('/api/register', null, { handle: 'alice', display_name: 'Alice' });
const gpt = await rest('/api/agents', alice.token, { handle: 'chatgpt', runtime: 'chatgpt' });
const cl = await rest('/api/agents', alice.token, { handle: 'claude', runtime: 'claude-code' });
console.log('Registered @alice with agents @chatgpt and @claude');

// ChatGPT custom connectors cannot send headers -> token in URL. Claude Code uses a Bearer header.
const chatgpt = mcpClient('chatgpt', `${base}/mcp/${gpt.token}`);
const claude = mcpClient('claude ', `${base}/mcp`, { authorization: `Bearer ${cl.token}` });

// 1. User in ChatGPT: "把刚才的竞品调研交给 Claude 写 PRD"
const shared = await chatgpt('share_context', {
  to: '@claude',
  task_goal: 'Draft an MVP PRD from the approved Agent Messenger market research',
  summary: 'Hybrid group chat already exists; defensibility = cross-vendor network + authorized context handoff + reliable delivery.',
  confirmed_findings: ['Consumer apps are outbound-first (MCP tools)', 'MCP alone cannot wake an idle session'],
  constraints: ['Do not assume access to personal ChatGPT memory'],
  sources: [{ title: 'Grok Bot collaboration docs', url: 'https://docs.x.ai/grok-bot/chat-and-collaboration', retrieved_at: '2026-11-16' }],
  artifacts: [{ title: 'research.md', mime_type: 'text/markdown', content: '# Agent Messenger research\n…full text…' }],
});
const task = await chatgpt('delegate_task', {
  to: '@claude', title: 'Write the MVP PRD', instructions: 'Use the context package; reply with the PRD.',
  context_id: shared.context.context_id,
});

// 2. User in Claude Code: "看看收件箱" — Claude pulls, reads the authorized context, works, reports back.
const inbox = await claude('get_inbox');
console.log(`  → ${inbox.count} message(s):`, inbox.messages.map((m) => `${m.kind} from @${m.sender.handle}`).join(', '));
const ctx = await claude('get_context', { context_id: shared.context.context_id });
console.log(`  → goal: "${ctx.task_goal}", ${ctx.confirmed_findings.length} findings, artifact "${ctx.artifacts[0].title}"`);
await claude('update_task', { task_id: task.task.task_id, status: 'in_progress' });
await claude('update_task', { task_id: task.task.task_id, status: 'completed', result: '# PRD: Agent Messenger MVP\n1. Goals …' });
await claude('ack_messages', { message_ids: inbox.messages.map((m) => m.id) });

// 3. Back in ChatGPT: "Claude 回复了吗？"
const back = await chatgpt('get_inbox');
for (const m of back.messages) console.log(`  → @${m.sender.handle}: ${m.text.split('\n')[0]}`);
const done = (await chatgpt('list_tasks', { status: 'completed' }))[0];
console.log(`  → task "${done.title}" is ${done.status}; result starts: ${done.result.split('\n')[0]}`);

// 4. Access control: revoke, then Claude can no longer read the package.
await chatgpt('revoke_context', { context_id: shared.context.context_id });
await claude('get_context', { context_id: shared.context.context_id });

console.log('\nDemo finished: no file was downloaded or uploaded.');
server.close();
server.closeAllConnections();
