import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { initHome } from '../home/index.ts'

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
export function openDatabase(dir: string) {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'workbench.sqlite'))
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
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
    PRAGMA user_version=1;
  `)
  initHome(db)
  db.exec('CREATE TABLE IF NOT EXISTS project_workspaces(projectId TEXT REFERENCES projects(id), instanceId TEXT REFERENCES instances(id), PRIMARY KEY(projectId,instanceId))')
  if(!db.prepare('PRAGMA table_info(project_workspaces)').all().some(c=>c.name==='allowAgentAccess'))db.exec('ALTER TABLE project_workspaces ADD COLUMN allowAgentAccess INTEGER NOT NULL DEFAULT 0')
  const columns=db.prepare('PRAGMA table_info(instances)').all()
  for(const [name,schema] of [['capabilities',"TEXT NOT NULL DEFAULT '{}'"],['profileId',"TEXT NOT NULL DEFAULT 'default'"]]){
    if(!columns.some(c=>c.name===name))db.exec('ALTER TABLE instances ADD COLUMN '+name+' '+schema)
  }
  db.exec('UPDATE instances SET online=0')
  return db
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
export const owner = {id:'owner',owner:true,projects:[] as string[]}
