import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type DB = DatabaseSync;
export type RunPermission = 'read'|'append'|'manage';
export type Principal = { id: string; owner: boolean; projects: string[]; runPermission?: RunPermission; communicationOnly?:boolean };
export type Context = { method: string; path: string; body: any; query: URLSearchParams; principal: Principal; dataDir: string };
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export function fail(status: number, msg: string, current?: unknown): never {
  throw Object.assign(new Error(msg), { status, current });
}
export function str(v: unknown, label: string): string {
  if (typeof v !== 'string' || !v.trim()) fail(400, `${label} 不能为空`);
  return v.trim();
}
export function list(v: unknown, label: string): any[] {
  if (!Array.isArray(v)) fail(400, `${label} 应为数组`);
  return v;
}
export function obj(v: unknown, label: string): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, `${label} 应为对象`);
  return v as Record<string, any>;
}
export function strings(v: unknown, label: string): string[] {
  return [...new Set(list(v, label).map(x => str(x, label)))];
}
export function iso(v:unknown,name:string) {
  if(v==null)return null;
  if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))fail(400,'无效 '+name);
  return new Date(v).toISOString();
}
export function parse(raw: unknown): any { return JSON.parse(String(raw)); }
export function one(db: DB, sql: string, ...args: any[]): any { return db.prepare(sql).get(...args); }
export function rows(db: DB, sql: string, ...args: any[]): any[] { return db.prepare(sql).all(...args); }
export function run(db: DB, sql: string, ...args: any[]) { return db.prepare(sql).run(...args); }
export function projectAccess(db: DB, p: Principal, id: string | null) {
  if (!p.owner && (!id || !p.projects.includes(id))) fail(403, '缺少该项目权限');
  if (id && !one(db, 'SELECT id FROM projects WHERE id=?',id)) fail(404, '项目不存在');
}
export function revision(actual: number, expected: unknown, current: unknown) {
  if (typeof expected !== 'number' || !Number.isInteger(expected)) fail(400, '需要整数 expectedRevision');
  if (expected !== actual) fail(409, '修订冲突', current);
}
