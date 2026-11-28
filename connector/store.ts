import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import type {Command} from './types.ts'
import {agentRuntimeScope} from '../contracts/agent-runtime.ts'
export type ReceiptStatus='received'|'done'|'uncertain'|'failed'
export type SavedCommand={id:string,body:string,status:ReceiptStatus,detail:string|null,submitted:number|null,digest:string|null}
function stable(value:any):any{
  if(Array.isArray(value))return value.map(stable)
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]))
  return value
}
function commandDigest(c:Command){
  const payload={...c.payload,
    ...(c.payload.homeAccess?{homeAccess:{...c.payload.homeAccess,token:undefined}}:{}),
    ...(c.payload.communicationAccess?{communicationAccess:{...c.payload.communicationAccess,token:undefined}}:{})}
  const semantic={id:c.id,threadId:c.threadId,runId:c.runId,taskId:c.taskId,instanceId:c.instanceId,
    projectId:c.projectId??null,profileId:c.profileId??null,workspaceRef:c.workspaceRef??null,
    runtimeScopeId:c.runtimeScopeId,kind:c.kind,payload}
  return createHash('sha256').update(JSON.stringify(stable(semantic))).digest('hex')
}
export class Store {
  db:DatabaseSync
  constructor(path:string) {
    this.db=new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000')
      this.migrate()
    }catch(e){this.db.close();throw e}
  }
  private migrate() {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const version=this.db.prepare('PRAGMA user_version').get()?.user_version
      if(version!==0 && version!==1 && version!==2)throw Error('连接器数据库版本高于当前支持的版本')
      if(version===0){
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,body TEXT NOT NULL,status TEXT NOT NULL,detail TEXT);
      CREATE TABLE IF NOT EXISTS bindings(thread TEXT PRIMARY KEY,instance TEXT NOT NULL,workspace TEXT NOT NULL,session TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,native TEXT,seq INTEGER NOT NULL DEFAULT 0,terminal INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS outbox(key TEXT PRIMARY KEY,event TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_items(run TEXT,item TEXT,PRIMARY KEY(run,item));
      CREATE TABLE IF NOT EXISTS receipt_acks(id TEXT PRIMARY KEY,status TEXT NOT NULL);`)
        if(!this.db.prepare('PRAGMA table_info(bindings)').all().some(c=>c.name==='runtime')) this.db.exec('ALTER TABLE bindings ADD COLUMN runtime TEXT')
        if(!this.db.prepare('PRAGMA table_info(commands)').all().some(c=>c.name==='submitted')) this.db.exec('ALTER TABLE commands ADD COLUMN submitted INTEGER')
        this.db.exec('PRAGMA user_version=1')
      }
      if(version<2){
        if(!this.db.prepare('PRAGMA table_info(commands)').all().some(c=>c.name==='digest'))
          this.db.exec('ALTER TABLE commands ADD COLUMN digest TEXT')
        this.db.exec('PRAGMA user_version=2')
      }
      this.db.exec('COMMIT')
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }
  command(c:Command) {
    // The server owns the input and credentials. Local recovery needs only routing IDs.
    const body=JSON.stringify({id:c.id,threadId:c.threadId,runId:c.runId,taskId:c.taskId,instanceId:c.instanceId,kind:c.kind,runtimeScopeId:c.runtimeScopeId})
    const digest=commandDigest(c)
    const prior=this.saved(c.id)
    if(prior && prior.body!==body) throw Object.assign(new Error('重复命令的路由目标不一致'),{code:'COMMAND_CONFLICT'})
    if(prior?.digest&&prior.digest!==digest)throw Object.assign(new Error('重复命令的执行内容、范围或配置不一致'),{code:'COMMAND_CONFLICT'})
    if(!prior) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.prepare("INSERT INTO commands(id,body,status,submitted,digest) VALUES(?,?,'received',0,?)").run(c.id,body,digest)
        this.db.prepare('INSERT OR IGNORE INTO runs(id) VALUES(?)').run(c.runId)
        this.db.exec('COMMIT')
      } catch(e) {this.db.exec('ROLLBACK');throw e}
    }
    return prior
  }
  saved(id:string) {
    return this.db.prepare('SELECT * FROM commands WHERE id=?').get(id) as SavedCommand|undefined
  }
  status(id:string,status:ReceiptStatus,detail='') {
    this.db.prepare('UPDATE commands SET status=?,detail=? WHERE id=?').run(status,detail,id)
  }
  submit(id:string) {
    this.db.prepare('UPDATE commands SET submitted=1 WHERE id=?').run(id)
  }
  pending(instanceId:string) {
    return this.db.prepare("SELECT * FROM commands WHERE status IN ('received','uncertain') AND json_extract(body,'$.instanceId')=? ORDER BY rowid").all(instanceId) as SavedCommand[]
  }
  binding(c:Command,workspace:string,runtime?:string,strict=false) {
    const row:any=this.db.prepare('SELECT * FROM bindings WHERE thread=?').get(c.threadId)
    if(row && (row.instance!==c.instanceId || row.workspace!==workspace || (row.runtime!=null && row.runtime!==runtime) ||
      (strict && (row.runtime==null || !runtime))))throw new Error('话题绑定的工作区、实例、账号或 profile 无法核对')
    return row?.session as string|undefined
  }
  bindingProof(thread:string,instance:string,workspace:string,session:string){
    const found=this.db.prepare('SELECT runtime FROM bindings WHERE thread=? AND instance=? AND workspace=? AND session=?')
      .get(thread,instance,workspace,session)
    return typeof found?.runtime==='string'&&found.runtime?agentRuntimeScope(found.runtime):undefined
  }
  bind(c:Command,workspace:string,session:string,runtime?:string,strict=false) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if(this.db.prepare(`SELECT 1 FROM bindings WHERE session=? AND workspace=? AND thread<>?
        AND ((runtime IS NULL AND instance=?) OR runtime=?) LIMIT 1`)
        .get(session,workspace,c.threadId,c.instanceId,runtime??null))throw Error('原生会话已绑定到另一个话题')
      this.db.prepare('INSERT OR IGNORE INTO bindings(thread,instance,workspace,session,runtime) VALUES(?,?,?,?,?)')
        .run(c.threadId,c.instanceId,workspace,session,runtime??null)
      if(this.binding(c,workspace,runtime,strict)!==session) throw new Error('话题正在使用另一原生会话')
      this.db.prepare('UPDATE bindings SET runtime=? WHERE thread=? AND runtime IS NULL').run(runtime??null,c.threadId)
      this.db.exec('COMMIT')
    } catch(e) {this.db.exec('ROLLBACK');throw e}
  }
  release(c:Command,workspace:string,runtime:string|undefined,session:string,strict=false){
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if(this.binding(c,workspace,runtime,strict)!==session)throw Error('待解除的原生会话绑定已变化')
      this.db.prepare('DELETE FROM bindings WHERE thread=? AND instance=? AND workspace=? AND session=? AND (runtime IS ? OR runtime IS NULL)')
        .run(c.threadId,c.instanceId,workspace,session,runtime??null)
      const run:any=this.db.prepare('SELECT * FROM runs WHERE id=?').get(c.runId)
      if(!run)throw Error('缺少解绑命令的持久运行记录')
      const seq=run.seq+1
      const key=createHash('sha256').update(JSON.stringify([c.instanceId,c.runId,seq])).digest('hex')
      const data={sessionId:session,nativeAction:'release',released:true}
      const event={key,seq,commandId:c.id,instanceId:c.instanceId,runId:c.runId,taskId:c.taskId,runtimeScopeId:c.runtimeScopeId,kind:'completed',data}
      this.db.prepare('UPDATE runs SET seq=?,terminal=1 WHERE id=?').run(seq,c.runId)
      this.db.prepare('INSERT INTO outbox VALUES(?,?)').run(key,JSON.stringify(event))
      this.db.prepare("UPDATE commands SET status='done',detail='' WHERE id=?").run(c.id)
      this.db.exec('COMMIT')
      return event
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }
  emit(c:Command,kind:string,data:any) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run:any=this.db.prepare('SELECT * FROM runs WHERE id=?').get(c.runId)
      if(run.terminal) {this.db.exec('COMMIT');return}
      if(kind==='message' && data.itemId) {
        const r=this.db.prepare('INSERT OR IGNORE INTO native_items VALUES(?,?)').run(c.runId,data.itemId)
        if(!r.changes) {this.db.exec('COMMIT');return}
      }
      const seq=run.seq+1
      const key=createHash('sha256').update(JSON.stringify([c.instanceId,c.runId,seq])).digest('hex')
      const event={key,seq,commandId:c.id,instanceId:c.instanceId,runId:c.runId,taskId:c.taskId,runtimeScopeId:c.runtimeScopeId,kind,data}
      const ended=['completed','cancelled','failed','blocked'].includes(kind)
      this.db.prepare('UPDATE runs SET seq=?,native=COALESCE(?,native),terminal=? WHERE id=?').run(seq,data.nativeRunId??null,Number(ended),c.runId)
      this.db.prepare('INSERT INTO outbox VALUES(?,?)').run(key,JSON.stringify(event))
      if(ended) this.status(c.id,kind==='failed'?'failed':'done',data.text||'')
      this.db.exec('COMMIT')
      return event
    } catch(e) {this.db.exec('ROLLBACK');throw e}
  }
}
