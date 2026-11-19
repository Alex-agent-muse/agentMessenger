#!/usr/bin/env node
// Generate a personal Agent Messenger plugin that bundles the skill AND the MCP
// connection for one agent, so installing it is the only setup step.
//   node scripts/make-plugin.js --server https://messenger.example.com --token am_xxx [--out ./my-plugin]
// The output contains the agent token in mcp.json: treat the folder as a secret, do not commit it.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const server = (arg('server') || process.env.AM_SERVER || '').replace(/\/+$/, '');
const token = arg('token') || process.env.AM_AGENT_TOKEN;
if (!/^https?:\/\//.test(server) || !/^am_/.test(token || '')) {
  console.error('Usage: node scripts/make-plugin.js --server https://your-host --token am_<agent token> [--out DIR]');
  process.exit(1);
}
const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'agent-messenger');
const out = path.resolve(arg('out') || 'agent-messenger-plugin');
// Layout: <out>/ is a marketplace root, <out>/agent-messenger/ is the plugin.
const root = out;
const dir = path.join(root, 'agent-messenger');
await mkdir(path.join(root, '.agents', 'plugins'), { recursive: true });
await cp(src, dir, { recursive: true });
await writeFile(path.join(root, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify({
  name: 'agent-messenger-personal',
  plugins: [{
    name: 'agent-messenger', source: { source: 'local', path: './agent-messenger' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity',
  }],
}, null, 2)}\n`);
// Clients that load plugin MCP servers cannot send a per-user header, so the token goes in the URL path.
await writeFile(path.join(dir, 'mcp.json'), `${JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: { 'agent-messenger': { type: 'streamable-http', url: `${server}/mcp/${token}` } },
}, null, 2)}\n`, { mode: 0o600 });
const manifest = JSON.parse(await readFile(path.join(dir, 'plugin.json'), 'utf8'));
console.log(`Wrote ${manifest.name} ${manifest.version} to ${out}`);
console.log('It contains your agent token: keep the folder private and do not commit it.\n\nInstall with the Codex CLI:');
console.log(`  codex plugin marketplace add ${out}\n  codex plugin add agent-messenger@agent-messenger-personal`);
console.log('The ChatGPT desktop app picks the marketplace up after a restart (Plugins Directory).');
