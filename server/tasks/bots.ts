import type {DatabaseSync} from 'node:sqlite'
import {fail, must, now} from '../db/index.ts'

export type BotAction='direct'|'delegate'

export function initBotSchema(db:DatabaseSync){
  const instanceColumns=db.prepare('PRAGMA table_info(instances)').all()
  if(!instanceColumns.some((column:any)=>column.name==='runtimeScopeId'))db.exec('ALTER TABLE instances ADD COLUMN runtimeScopeId TEXT')
  db.exec(`CREATE TABLE IF NOT EXISTS bot_settings(
    instanceId TEXT PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
    displayName TEXT,
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    allowDirect INTEGER NOT NULL DEFAULT 1 CHECK(allowDirect IN (0,1)),
    allowDelegate INTEGER NOT NULL DEFAULT 1 CHECK(allowDelegate IN (0,1)),
    allowedProjects TEXT,
    updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_threads(
    taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    threadId TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    relation TEXT NOT NULL CHECK(relation IN ('origin','work','direct')),
    createdAt TEXT NOT NULL,
    PRIMARY KEY(taskId,threadId)
  );
  CREATE INDEX IF NOT EXISTS task_threads_by_thread ON task_threads(threadId,createdAt DESC);
  INSERT OR IGNORE INTO task_threads(taskId,threadId,relation,createdAt)
    SELECT id,originThreadId,CASE WHEN originThreadId=workThreadId THEN 'direct' ELSE 'origin' END,createdAt
    FROM tasks WHERE originThreadId IS NOT NULL;
  INSERT OR IGNORE INTO task_threads(taskId,threadId,relation,createdAt)
    SELECT id,workThreadId,CASE WHEN originThreadId=workThreadId THEN 'direct' ELSE 'work' END,createdAt
    FROM tasks WHERE workThreadId IS NOT NULL;`)
}

function settings(db:DatabaseSync,instanceId:string){
  const instance=must(db,'SELECT id,name FROM instances WHERE id=?',instanceId)
  const saved=db.prepare('SELECT * FROM bot_settings WHERE instanceId=?').get(instanceId) as any
  return {
    instanceId,
    name:saved?.displayName??instance.name,
    description:saved?.description??'',
    enabled:saved?Boolean(saved.enabled):true,
    allowDirect:saved?Boolean(saved.allowDirect):true,
    allowDelegate:saved?Boolean(saved.allowDelegate):true,
    allowedProjects:saved?.allowedProjects?JSON.parse(saved.allowedProjects) as string[]:null,
    updatedAt:saved?.updatedAt??null
  }
}

export function botSettings(db:DatabaseSync,instanceId:string){
  return settings(db,instanceId)
}

export function listBots(db:DatabaseSync){
  return db.prepare('SELECT id,name,adapterKey,workspaceRef,profileId,nodeId,online,availableActions,capabilities FROM instances ORDER BY name,id')
    .all().map((row:any)=>({
      ...row,
      online:Boolean(row.online),
      availableActions:JSON.parse(row.availableActions||'[]'),
      capabilities:JSON.parse(row.capabilities||'{}'),
      settings:settings(db,String(row.id))
    }))
}

export function saveBotSettings(db:DatabaseSync,instanceId:string,body:any){
  must(db,'SELECT id FROM instances WHERE id=?',instanceId)
  if(!body||typeof body!=='object'||Array.isArray(body))fail('Bot 设置须为对象')
  const current=settings(db,instanceId)
  if(body.name!==undefined&&typeof body.name!=='string')fail('Bot 名称须为文本')
  if(body.description!==undefined&&typeof body.description!=='string')fail('Bot 描述须为文本')
  const name=body.name===undefined?current.name:body.name.trim()
  const description=body.description===undefined?current.description:body.description.trim()
  if(name.length<1||name.length>120)fail('Bot 名称须为 1 到 120 个字符')
  if(description.length>4000)fail('Bot 描述不能超过 4000 个字符')
  const flag=(key:string,value:boolean)=>body[key]===undefined?value:
    typeof body[key]==='boolean'?body[key]:fail(key+' 须为布尔值')
  let allowedProjects=current.allowedProjects
  if(body.allowedProjects!==undefined){
    if(body.allowedProjects===null)allowedProjects=null
    else if(Array.isArray(body.allowedProjects)&&body.allowedProjects.length<=500&&body.allowedProjects.every((id:any)=>typeof id==='string'&&id.length>0&&id.length<=128))
      allowedProjects=[...new Set<string>(body.allowedProjects)]
    else fail('允许项目须为项目 ID 数组或 null')
    if(allowedProjects&&allowedProjects.some((id:string)=>!db.prepare('SELECT 1 FROM projects WHERE id=?').get(id)))
      fail('允许项目列表包含不存在的项目',404)
  }
  const next={name,description,enabled:flag('enabled',current.enabled),allowDirect:flag('allowDirect',current.allowDirect),
    allowDelegate:flag('allowDelegate',current.allowDelegate),allowedProjects}
  db.prepare(`INSERT INTO bot_settings(instanceId,displayName,description,enabled,allowDirect,allowDelegate,allowedProjects,updatedAt)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(instanceId) DO UPDATE SET displayName=excluded.displayName,description=excluded.description,
    enabled=excluded.enabled,allowDirect=excluded.allowDirect,allowDelegate=excluded.allowDelegate,
    allowedProjects=excluded.allowedProjects,updatedAt=excluded.updatedAt`)
    .run(instanceId,next.name,next.description,Number(next.enabled),Number(next.allowDirect),Number(next.allowDelegate),
      next.allowedProjects===null?null:JSON.stringify(next.allowedProjects),now())
  return settings(db,instanceId)
}

export function assertBotAllowed(db:DatabaseSync,instanceId:string,action:BotAction,projectId:string|null){
  const configured=settings(db,instanceId)
  if(!configured.enabled)fail('此 Bot 已停用',409)
  if(action==='direct'&&!configured.allowDirect)fail('此 Bot 当前不允许用户直聊',409)
  if(action==='delegate'&&!configured.allowDelegate)fail('此 Bot 当前不允许小毛球委派任务',409)
  assertBotProjectAllowed(db,instanceId,projectId)
  return configured
}

export function assertBotProjectAllowed(db:DatabaseSync,instanceId:string,projectId:string|null){
  const configured=settings(db,instanceId)
  if(configured.allowedProjects&&(!projectId||!configured.allowedProjects.includes(projectId)))
    fail('此 Bot 未获准用于该项目或个人范围',403)
  return configured
}

export function tasksForThread(db:DatabaseSync,threadId:string){
  return db.prepare(`SELECT t.*,x.relation FROM task_threads x JOIN tasks t ON t.id=x.taskId
    WHERE x.threadId=? ORDER BY t.createdAt DESC,t.id`).all(threadId)
}

export function routingBots(db:DatabaseSync,projectId:string|null){
  const mapped=projectId?new Set(db.prepare('SELECT instanceId FROM project_workspaces WHERE projectId=?')
    .all(projectId).map(row=>row.instanceId)):null
  return listBots(db).filter(bot=>{
    const s=bot.settings
    return s.enabled&&s.allowDelegate&&(!mapped||mapped.has(bot.id))&&(!s.allowedProjects||projectId&&s.allowedProjects.includes(projectId))
  }).map(({id,adapterKey,name,nodeId,profileId,workspaceRef,online,availableActions,capabilities,settings})=>({
    id,name:settings.name||name,description:settings.description,adapterKey,nodeId,profileId,workspaceRef,online,availableActions,
    capabilities:{resume:capabilities.resume,sessionList:capabilities.sessionList,nativeHistory:capabilities.nativeHistory,
      nativeActions:capabilities.nativeActions??[],contextOwner:capabilities.contextOwner,modelCount:capabilities.models?.length??0},
    activeRuns:db.prepare("SELECT count(*) n FROM runs WHERE instanceId=? AND status IN ('queued','running','waiting_input','cancelling','uncertain')").get(id)?.n,
    allowedProjects:settings.allowedProjects,allowDelegate:settings.allowDelegate
  }))
}
