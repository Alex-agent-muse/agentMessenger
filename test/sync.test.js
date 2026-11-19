// Automatic sync: every client is told to schedule its own recurring inbox check
// on first use, and the user can change the interval or stop it from the chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function setup(t, opts) {
  const { server, messenger: m } = createApp(opts);
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://localhost:${server.address().port}`;
  const owner = m.authenticate(m.registerHuman({ handle: 'alice' }).token);
  const mk = (handle) => {
    const { token, agent } = m.createAgent(owner, { handle });
    let id = 0;
    const call = async (name, args = {}) => {
      const res = await fetch(`${base}/mcp/${token}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      });
      const { result } = await res.json();
      return { data: JSON.parse(result.content[0].text), notice: result.content[1]?.text ?? null, isError: !!result.isError };
    };
    const rpc = async (method, params) => (await (await fetch(`${base}/mcp/${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    })).json()).result;
    return { call, rpc, id: agent.id, token };
  };
  return { m, base, owner, mk };
}

test('first use asks the client to schedule a sync; confirming it silences the notice', async (t) => {
  const { m, mk } = await setup(t);
  const a = mk('chatgpt');

  // Any first tool call carries the setup step, whichever tool it is.
  const first = await a.call('whoami');
  assert.equal(first.data.sync.state, 'pending');
  assert.match(first.notice, /automatic inbox sync is not running \(default: every 5 minutes\)/);
  assert.match((await a.call('list_conversations')).notice, /not running/); // array results too
  // The how-to lives in the connector instructions and in sync_settings, not in an imperative tool result.
  const init = await a.rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.match(init.instructions, /Automatic sync setup: Automatic sync is not set up yet for @chatgpt/);
  assert.match(init.instructions, /runs every 5 minutes/);
  assert.match((await a.call('sync_settings')).data.next_step, /sync_settings with scheduled=true/);

  // The client created its recurring task and reports back.
  const ok = await a.call('sync_settings', { scheduled: true });
  assert.equal(ok.data.state, 'active');
  assert.equal(ok.notice, null);
  assert.equal((await a.call('whoami')).notice, null);
  assert.equal((await a.call('get_inbox')).notice, null);
  assert.match((await a.rpc('initialize', {})).instructions, /Automatic sync is on for @chatgpt, every 5 minutes/);

  // If the scheduled checks stop arriving, the setup step comes back by itself.
  m.db.prepare('UPDATE principals SET last_inbox_at = ? WHERE id = ?').run(new Date(Date.now() - 16 * 60_000).toISOString(), a.id);
  const lapsed = await a.call('whoami');
  assert.equal(lapsed.data.sync.state, 'pending');
  assert.match(lapsed.notice, /not running/);
});

test('the user can change the interval, stop and resume from the conversation', async (t) => {
  const { mk } = await setup(t);
  const a = mk('claude');
  await a.call('sync_settings', { scheduled: true });

  // "check every 15 minutes"
  const changed = await a.call('sync_settings', { interval_minutes: 15 });
  assert.equal(changed.data.interval_minutes, 15);
  assert.equal(changed.data.state, 'pending'); // the client must reschedule...
  assert.match(changed.data.next_step, /every 15 minutes/);
  assert.match((await a.call('whoami')).notice, /every 15 minutes/);
  assert.match(changed.data.next_step, /scheduled=true/);
  assert.equal((await a.call('sync_settings', { scheduled: true })).data.state, 'active'); // ...and confirm

  // "stop syncing"
  const stopped = await a.call('sync_settings', { enabled: false });
  assert.equal(stopped.data.state, 'stopped');
  assert.match(stopped.data.next_step, /Cancel the recurring inbox task/);
  assert.equal((await a.call('whoami')).notice, null); // no nagging while stopped
  assert.equal((await a.call('sync_settings')).data.state, 'stopped'); // reading does not change it

  // "resume syncing" keeps the interval the user chose
  const resumed = await a.call('sync_settings', { enabled: true });
  assert.equal(resumed.data.state, 'pending');
  assert.equal(resumed.data.interval_minutes, 15);

  assert.equal((await a.call('sync_settings', { interval_minutes: 0 })).isError, true);
});

test('a client without scheduling opts out once and is not asked again; settings are per agent', async (t) => {
  const { mk } = await setup(t);
  const a = mk('plain'), b = mk('other');
  const r = await a.call('sync_settings', { scheduled: false });
  assert.equal(r.data.state, 'unsupported');
  assert.equal((await a.call('whoami')).notice, null);
  assert.match((await b.call('whoami')).notice, /not running/); // b is unaffected
});

test('server default: AM_SYNC_MINUTES=0 turns auto-sync off, another value changes the default', async (t) => {
  const off = await setup(t, { syncMinutes: 0 });
  const a = off.mk('quiet');
  assert.equal((await a.call('whoami')).notice, null);
  assert.equal((await a.call('whoami')).data.sync.state, 'stopped');
  const ten = await setup(t, { syncMinutes: 10 });
  assert.match((await ten.mk('ten').call('whoami')).notice, /every 10 minutes/);
});

test('databases created before sync existed are upgraded in place', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'am-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE principals(id TEXT PRIMARY KEY, kind TEXT NOT NULL, handle TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    owner_id TEXT, token_hash TEXT NOT NULL UNIQUE, runtime TEXT, description TEXT, webhook_url TEXT, webhook_secret TEXT,
    created_at TEXT NOT NULL, last_seen_at TEXT);
    INSERT INTO principals(id, kind, handle, display_name, token_hash, created_at) VALUES ('agt_1','agent','old','Old','h','2026-01-01');`);
  old.close();
  const db = openDb(file);
  const row = db.prepare('SELECT sync_state, sync_minutes, last_inbox_at FROM principals').get();
  assert.equal(row.sync_state, 'pending');
  assert.equal(row.sync_minutes, null);
  openDb(file); // idempotent
});
