import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { initHome } from '../home/index.ts'
import { initSearch } from '../home/search.ts'
import { initSessions } from './sessions.ts'
import { initChatBudget } from './chat-budget.ts'
import { initBotSchema } from '../tasks/bots.ts'
import type { Principal } from '../home/common.ts'

export const id = () => randomUUID()
export const now = () => new Date().toISOString()
export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status })
}
export function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail('缺少有效的 ' + label)
  return value.trim()
}
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const result = fn(); db.exec('COMMIT'); return result }
  catch (e) { db.exec('ROLLBACK'); throw e }
}
export function migrate(db:DatabaseSync, migrations:readonly ((db:DatabaseSync)=>void)[]) {
  transaction(db,()=>{
    const version=Number(db.prepare('PRAGMA user_version').get()?.user_version)
    if(version>migrations.length)throw Error('数据库版本高于当前工作台支持的版本')
    for(let i=version;i<migrations.length;i++){
      migrations[i](db)
      db.exec('PRAGMA user_version='+(i+1))
    }
  })
}
export function openDatabase(dir: string) {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'workbench.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON')
    migrate(db,[initLegacySchema,db=>{
      // Legacy releases could set v1 before finishing the initial schema.
      initLegacySchema(db)
      db.exec(`
        ALTER TABLE grants ADD COLUMN expiresAt TEXT;
        UPDATE grants SET expiresAt=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days');
        CREATE INDEX grants_expiry ON grants(expiresAt);
        ALTER TABLE run_grants ADD COLUMN expiresAt TEXT;
        ALTER TABLE run_grants ADD COLUMN permission TEXT NOT NULL DEFAULT 'read';
        CREATE INDEX run_grants_expiry ON run_grants(expiresAt);
        ALTER TABLE project_workspaces ADD COLUMN agentPermission TEXT NOT NULL DEFAULT 'read';
        DELETE FROM run_grants;
        CREATE INDEX commands_node_dispatch ON commands(instanceId,status);
      `)
    },initSearch,db=>db.exec(`
      CREATE TABLE thread_summaries(threadId TEXT PRIMARY KEY REFERENCES threads(id),
        throughMessageId TEXT NOT NULL REFERENCES messages(id), body TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE INDEX task_project ON tasks(projectId);
      CREATE INDEX task_origin ON tasks(originThreadId);
      CREATE INDEX msg_review_task ON messages(taskId) WHERE kind='review';
      CREATE INDEX msg_artifact_thread ON messages(threadId) WHERE kind='artifact';
      UPDATE record_revisions AS v
      SET snapshot=(SELECT json_set(v.snapshot,'$.extra.verificationSource','user','$.extra.reviewId',m.id,
          '$.extra.verified',json(COALESCE((SELECT json_group_array(json(c.value))
             FROM json_each(m.data,'$.checks') c WHERE json_extract(c.value,'$.met')=1),'[]')))
        FROM records r JOIN messages m ON m.taskId=r.task_id AND m.kind='review' AND m.role='user'
        WHERE r.id=v.record_id AND r.submitter='server' AND m.text=json_extract(v.snapshot,'$.body')
          AND json_extract(m.data,'$.runId')=json_extract(v.snapshot,'$.extra.runId')
        ORDER BY m.rowid DESC LIMIT 1)
      WHERE EXISTS(SELECT 1 FROM records r JOIN messages m ON m.taskId=r.task_id AND m.kind='review' AND m.role='user'
        WHERE r.id=v.record_id AND r.submitter='server' AND m.text=json_extract(v.snapshot,'$.body')
          AND json_extract(m.data,'$.runId')=json_extract(v.snapshot,'$.extra.runId'));
    `),db=>db.exec(`
      CREATE TABLE thread_context_resets(threadId TEXT PRIMARY KEY REFERENCES threads(id),
        throughMessageId TEXT NOT NULL REFERENCES messages(id),version INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX msg_recovery_thread ON messages(threadId) WHERE kind='recovery';
      CREATE INDEX chat_job_thread_status ON chat_jobs(threadId,status);
    `),db=>db.exec(`
      ALTER TABLE chat_jobs ADD COLUMN operation TEXT;
      ALTER TABLE chat_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'user_turn';
      CREATE INDEX chat_jobs_dispatch ON chat_jobs(status,kind,id);
      CREATE TABLE communication_grants(runId TEXT PRIMARY KEY REFERENCES runs(id), token TEXT NOT NULL,
        tokenHash TEXT NOT NULL UNIQUE, expiresAt TEXT NOT NULL);
      CREATE TABLE daily_items(id TEXT PRIMARY KEY, projectId TEXT REFERENCES projects(id),threadId TEXT NOT NULL REFERENCES threads(id),
        kind TEXT NOT NULL CHECK(kind IN ('todo','reminder')),body TEXT NOT NULL,dueAt TEXT,state TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE INDEX daily_due ON daily_items(dueAt) WHERE kind='reminder' AND state='open';
      CREATE TABLE memory_candidates(id TEXT PRIMARY KEY,threadId TEXT NOT NULL REFERENCES threads(id),
        messageId TEXT NOT NULL UNIQUE REFERENCES messages(id), projectId TEXT REFERENCES projects(id),
        body TEXT NOT NULL,factKey TEXT,recordType TEXT NOT NULL,important INTEGER NOT NULL,status TEXT NOT NULL,createdAt TEXT NOT NULL);
    `),db=>{initSessions(db);initBotSchema(db);initChatBudget(db)}])
    db.exec('UPDATE instances SET online=0')
    db.function('maoqiu_fact_key',{deterministic:true},value=>typeof value==='string'?normalizeFactKey(value):null)
    return db
  }catch(e){db.close();throw e}
}
export function normalizeFactKey(value:string){
  return value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase()
}
function initLegacySchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances(id TEXT PRIMARY KEY, nodeId TEXT NOT NULL, name TEXT, adapterKey TEXT, workspaceRef TEXT, availableActions TEXT, lastSeen TEXT, online INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,title TEXT,instanceId TEXT,projectId TEXT,taskId TEXT,sessionId TEXT,createdAt TEXT);
    CREATE TABLE IF NOT EXISTS thread_models(threadId TEXT PRIMARY KEY REFERENCES threads(id),selected TEXT,current TEXT,options TEXT);
    CREATE TABLE IF NOT EXISTS task_drafts(threadId TEXT PRIMARY KEY REFERENCES threads(id),originThreadId TEXT NOT NULL REFERENCES threads(id));
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,threadId TEXT NOT NULL REFERENCES threads(id),role TEXT,kind TEXT,text TEXT,taskId TEXT,refs TEXT,data TEXT,createdAt TEXT);
    CREATE INDEX IF NOT EXISTS msg_thread ON messages(threadId);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,originThreadId TEXT REFERENCES threads(id),workThreadId TEXT REFERENCES threads(id),instanceId TEXT,projectId TEXT,goal TEXT,brief TEXT,status TEXT,createdAt TEXT);
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,threadId TEXT REFERENCES threads(id),taskId TEXT REFERENCES tasks(id),instanceId TEXT,status TEXT,nativeRunId TEXT,pendingRequest TEXT,createdAt TEXT);
    CREATE INDEX IF NOT EXISTS run_thread ON runs(threadId);
    CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,threadId TEXT,runId TEXT REFERENCES runs(id),taskId TEXT,instanceId TEXT,kind TEXT,payload TEXT,status TEXT,detail TEXT,createdAt TEXT);
    CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT,body TEXT);
    CREATE TABLE IF NOT EXISTS node_events(nodeId TEXT,runId TEXT,seq INTEGER,eventKey TEXT,PRIMARY KEY(nodeId,runId,seq),UNIQUE(nodeId,eventKey));
    CREATE TABLE IF NOT EXISTS requests(principal TEXT,requestId TEXT,signature TEXT,result TEXT,PRIMARY KEY(principal,requestId));
    CREATE TABLE IF NOT EXISTS chat_jobs(id INTEGER PRIMARY KEY,threadId TEXT,messageId TEXT UNIQUE,status TEXT);
    CREATE TABLE IF NOT EXISTS grants(tokenHash TEXT PRIMARY KEY,id TEXT,projectId TEXT);
    CREATE TABLE IF NOT EXISTS run_grants(runId TEXT PRIMARY KEY REFERENCES runs(id),tokenHash TEXT UNIQUE,token TEXT,projectId TEXT,instanceId TEXT);
  `)
  initHome(db)
  db.exec('CREATE TABLE IF NOT EXISTS project_workspaces(projectId TEXT REFERENCES projects(id), instanceId TEXT REFERENCES instances(id), PRIMARY KEY(projectId,instanceId))')
  if(!db.prepare('PRAGMA table_info(project_workspaces)').all().some(c=>c.name==='allowAgentAccess'))db.exec('ALTER TABLE project_workspaces ADD COLUMN allowAgentAccess INTEGER NOT NULL DEFAULT 0')
  const columns=db.prepare('PRAGMA table_info(instances)').all()
  for(const [name,schema] of [['capabilities',"TEXT NOT NULL DEFAULT '{}'"],['profileId',"TEXT NOT NULL DEFAULT 'default'"]]){
    if(!columns.some(c=>c.name===name))db.exec('ALTER TABLE instances ADD COLUMN '+name+' '+schema)
  }
}
export function changed(db: DatabaseSync, kind: string, body: Record<string,unknown>) {
  db.prepare('INSERT INTO events(kind,body) VALUES(?,?)').run(kind, JSON.stringify(body))
}
export const unpack = (row: any, fields: string[]) => {
  if (!row) return row
  const result = { ...row }
  for (const field of fields) if (typeof result[field] === 'string') result[field] = JSON.parse(result[field])
  return result
}
export function one(db: DatabaseSync, sql: string, ...args: any[]): any { return db.prepare(sql).get(...args) }
export function must(db: DatabaseSync, sql: string, ...args: any[]) {
  return one(db,sql,...args) ?? fail('记录不存在',404)
}
export const owner:Principal = {id:'owner',owner:true,projects:[]}
