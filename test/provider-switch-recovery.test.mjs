import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { once } from 'node:events'
import WebSocket from 'ws'
import { openDatabase } from '../server/db/index.ts'
import { startServer } from '../server/index.ts'
import { commitCodexSwitch, recoverCodexSwitch } from '../desktop/codex-switch-recovery.cjs'
import { maintainConnector } from '../desktop/connector-maintenance.cjs'

const old = Buffer.from('{ "mode": "official", "env": {"FAKE_KEY":"fixture-only"} }\n')
const next = Buffer.from('{ "mode": "native", "env": {"FAKE_KEY":"fixture-only"} }\n')
const a = 'a'.repeat(64)
const b = 'b'.repeat(64)

const temp = () => mkdtempSync(join(tmpdir(), 'maoqiu-provider-switch-'))
const cleanup = dir => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

function setup(t) {
  const dir = temp()
  const file = join(dir, 'desktop-connector.json')
  const db = openDatabase(dir)
  t.after(() => { db.close(); cleanup(dir) })
  writeFileSync(file, old)
  db.prepare(`INSERT INTO instances(id,nodeId,name,adapterKey,workspaceRef,availableActions,lastSeen,online,capabilities,profileId,runtimeScopeId)
    VALUES('codex','local','Codex','codex',?,'["run"]','2026-11-28T00:00:00Z',1,'{}','default',?)`).run(dir, a)
  db.prepare(`INSERT INTO threads(id,instanceId,title,kind,state,sessionId,createdAt,nativeRuntimeScopeId)
    VALUES('old','codex','Topic','native','active','session','2026-11-28T00:00:00Z',?)`).run(a)
  const update = () => {
    db.prepare("UPDATE instances SET runtimeScopeId=?,online=0 WHERE id='codex'").run(b)
    db.exec("UPDATE threads SET state='archived' WHERE id='old'")
  }
  const snapshot = () => [
    ...Object.values(db.prepare("SELECT runtimeScopeId,online FROM instances WHERE id='codex'").get()),
    ...Object.values(db.prepare("SELECT state,nativeRuntimeScopeId FROM threads WHERE id='old'").get())
  ]
  return { dir, file, db, update, snapshot }
}

test('desktop switch restores the original file and SQLite when begin, update or commit fails', t => {
  const { dir, file, db, update, snapshot } = setup(t)
  for (const failure of ['BEGIN IMMEDIATE', 'update', 'COMMIT']) {
    const injected = {
      get isTransaction() { return db.isTransaction },
      exec(sql) { if (sql === failure) throw Error('fixture ' + failure); return db.exec(sql) },
      prepare: sql => db.prepare(sql)
    }
    assert.throws(() => commitCodexSwitch(file, injected, old, next, () => {
      update()
      if (failure === 'update') {
        assert.deepEqual(readFileSync(file), next)
        throw Error('fixture update')
      }
    }), new RegExp('fixture ' + failure))
    assert.deepEqual(readFileSync(file), old)
    assert.deepEqual(snapshot(), [a, 1, 'active', a])
    assert.deepEqual(db.prepare('SELECT id FROM desktop_codex_switch').all(), [])
    assert.equal(readdirSync(dir).some(name => name.includes('.codex-switch')), false)
  }
})

const crashScript = `
  import { DatabaseSync } from 'node:sqlite';
  import { commitCodexSwitch } from './desktop/codex-switch-recovery.cjs';
  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';
  const [dir,file,where]=process.argv.slice(1);
  const db=new DatabaseSync(join(dir,'workbench.sqlite'));
  const previous=readFileSync(file);
  const next=Buffer.from(previous.toString().replace('"official"','"native"'));
  const interrupted={
    prepare: sql=>db.prepare(sql),
    exec(sql) {
      db.exec(sql);
      if(where==='after'&&sql==='COMMIT')process.exit(72);
    }
  };
  commitCodexSwitch(file,interrupted,previous,next,()=>{
    db.prepare("UPDATE instances SET runtimeScopeId=?,online=0 WHERE id='codex'").run('b'.repeat(64));
    db.exec("UPDATE threads SET state='archived' WHERE id='old'");
    if(where==='before')process.exit(71);
  });
`

for (const where of ['before', 'after']) {
  test('desktop switch recovers idempotently after real process exit ' + where + ' SQLite commit', t => {
    const { dir, file, db, snapshot } = setup(t)
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', crashScript, dir, file, where],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    const committed = where === 'after'
    assert.equal(child.status, committed ? 72 : 71, child.stderr)
    assert.equal(readFileSync(file, 'utf8').includes('"native"'), true)
    assert.equal(readFileSync(file + '.codex-switch.json', 'utf8').includes('fixture-only'), false)
    for (let i = 0; i < 2; i++) recoverCodexSwitch(file, db)
    assert.deepEqual(snapshot(), committed ? [b, 0, 'archived', a] : [a, 1, 'active', a])
    assert.deepEqual(readFileSync(file), committed ? next : old)
    assert.equal(readdirSync(dir).some(name => name.includes('.codex-switch')), false)
  })
}

test('desktop switch retains a manually edited configuration and rejects a damaged recovery record', t => {
  const { dir, file, db, snapshot } = setup(t)
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', crashScript, dir, file, 'before'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(child.status, 71, child.stderr)
  writeFileSync(file, '{"user":"manual edit"}\n')
  assert.throws(() => recoverCodexSwitch(file, db), /配置文件已变化/)
  assert.match(readFileSync(file, 'utf8'), /manual edit/)
  assert.deepEqual(snapshot(), [a, 1, 'active', a])
  writeFileSync(file + '.codex-switch.json', '{broken record')
  assert.throws(() => recoverCodexSwitch(file, db), /无法核对.*恢复记录/)
  assert.match(readFileSync(file, 'utf8'), /manual edit/)
})

test('maintenance resumes the previous connector after queue changes or writes fail; a timed-out child stays fenced', async () => {
  for (const fault of ['busy', 'late queue', 'write', 'both', 'stop', 'start']) {
    let paused = false
    let running = true
    let checks = 0
    let launches = 0
    let deferred = false
    const lifecycle = {
      pause(value) { const previous = paused; paused = value; return previous },
      assertIdle() {
        assert.equal(paused, true)
        if (fault === 'busy' || ++checks === 2 && fault === 'late queue') throw Error(fault)
      },
      stop() {
        if (fault === 'stop') throw Error('stop')
        running = false
      },
      running: () => running,
      resumeAfterExit() { deferred = true },
      resume() {
        assert.equal(running, false)
        launches++
        if (fault === 'both' || fault === 'start') throw Error('start')
        running = true
        paused = false
      }
    }
    const call = maintainConnector(lifecycle, {}, () => {
      if (fault === 'late queue') assert.fail('a late queue must prevent the change')
      if (fault === 'write' || fault === 'both') throw Error('write')
      return 'saved'
    })
    if (fault === 'start') {
      const settled = await call
      assert.equal(settled.result, 'saved')
      assert.match(settled.startError.message, /start/)
    } else {
      await assert.rejects(call, fault === 'both' ? /write.*start/ : new RegExp(fault))
    }
    assert.equal(launches, ['busy', 'stop'].includes(fault) ? 0 : 1)
    assert.equal(paused, ['both', 'stop', 'start'].includes(fault))
    assert.equal(deferred, fault === 'stop')
  }
})

test('paused local dispatch leaves a newly queued prepare durable and unsent', async t => {
  const dir = temp()
  const server = startServer({ dataDir: dir, port: 0, chat: false })
  t.after(async () => { await server.close(); cleanup(dir) })
  await once(server.server, 'listening')
  const port = server.server.address().port
  const first = '11111111-1111-4111-a111-111111111111'
  const second = '22222222-2222-4222-a222-222222222222'
  const connect = generation => new WebSocket('ws://127.0.0.1:' + port + '/api/v1/node', {
    headers: { Authorization: 'Bearer ' + server.auth.cfg.nodes.local, 'X-Maoqiu-Connector-Generation': generation }
  })
  server.expectLocalGeneration(first)
  const ws = connect(first)
  t.after(() => ws.terminate())
  await once(ws, 'open')
  server.pauseLocalDispatch(true)
  ws.send(JSON.stringify({ type: 'hello', instances: [{ id: 'dsh', name: 'DSH', adapterKey: 'dsh',
    workspaceRef: dir, availableActions: ['prepare'] }] }))
  for (let i = 0; i < 50; i++) {
    if (server.db.prepare("SELECT online FROM instances WHERE id='dsh'").get()?.online === 1) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(server.db.prepare("SELECT online FROM instances WHERE id='dsh'").get()?.online, 1)
  server.db.exec(`
    INSERT INTO threads(id,instanceId,title,kind,state,createdAt) VALUES('thread','dsh','Topic','native','active','2026-11-28');
    INSERT INTO runs(id,threadId,instanceId,status,createdAt) VALUES('run','thread','dsh','queued','2026-11-28');
    INSERT INTO commands(id,threadId,runId,instanceId,kind,payload,status,createdAt)
      VALUES('prepare','thread','run','dsh','prepare','{}','queued','2026-11-28');`)
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(server.db.prepare("SELECT status FROM commands WHERE id='prepare'").get().status, 'queued')
  const received = once(ws, 'message', { signal: AbortSignal.timeout(2000) })
  server.pauseLocalDispatch(false)
  const [raw] = await received
  assert.equal(JSON.parse(raw).command.id, 'prepare')
  assert.equal(server.db.prepare("SELECT status FROM commands WHERE id='prepare'").get().status, 'sent')
  const oldClosed = once(ws, 'close')
  server.expectLocalGeneration(second)
  await oldClosed
  assert.equal(server.db.prepare("SELECT online FROM instances WHERE id='dsh'").get().online, 0)
  const stale = connect(first)
  const [staleError] = await once(stale, 'error', { signal: AbortSignal.timeout(2000) })
  assert.ok(staleError)
})
