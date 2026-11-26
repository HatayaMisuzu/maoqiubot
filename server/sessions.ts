import type { DatabaseSync } from 'node:sqlite'
import { changed, fail, id, must, now, one, required, unpack } from './db/index.ts'
import { assertBotAllowed } from './tasks/bots.ts'
import { createThread, getThread, homeRead, message, messages } from './tasks/index.ts'
import { modelSettings, selectedModel, type ModelConfig } from './chat/model-settings.ts'

type Sharing = Pick<ModelConfig,'shareProject'|'sharePersonal'|'shareAttachments'> | undefined
const readable = (state:string) => state==='active' || state==='archived'
const visibleMessage = `m.kind IN ('message','task_update') AND COALESCE(json_extract(m.data,'$.communication.visibility'),'user_visible')='user_visible'`
const afterReset = `COALESCE((SELECT anchor.rowid FROM thread_context_resets reset JOIN messages anchor ON anchor.id=reset.throughMessageId
  WHERE reset.threadId=m.threadId),0)`
const historyRows = `FROM messages m JOIN threads t ON t.id=m.threadId
  LEFT JOIN messages parent ON parent.id=COALESCE(json_extract(m.data,'$.replyTo'),json_extract(m.data,'$.communication.replyTo')) AND parent.threadId=m.threadId
  WHERE t.state IN ('active','archived') AND t.instanceId='main' AND ${visibleMessage}
  AND COALESCE(parent.kind,'')<>'deleted_message' AND m.rowid>${afterReset} AND COALESCE(parent.rowid,m.rowid)>${afterReset}`

function integer(value:unknown, fallback:number, max:number, min=1){
  const number=Number(value??fallback)
  if(!Number.isSafeInteger(number)||number<min||number>max)fail('分页参数超出范围')
  return number
}

export function mainThread(db:DatabaseSync){
  return must(db,"SELECT * FROM threads WHERE kind='main'")
}

export function listThreads(db:DatabaseSync,query:URLSearchParams){
  const state=query.get('state')??'active'
  if(!['active','deleted','archived'].includes(state))fail('未知会话状态')
  const instance=query.get('instanceId')
  const title=(query.get('q')??'').trim()
  if(title.length>120)fail('会话检索词最多 120 字符')
  const project=query.get('projectId')||null
  // Legacy callers without pagination expect the full list.
  const limit=query.has('limit')?integer(query.get('limit'),50,200):-1
  return db.prepare(`SELECT t.* FROM threads t WHERE state=? AND (? IS NULL OR instanceId=?)
    AND (?=0 OR projectId IS ?) AND instr(lower(COALESCE(title,'')),lower(?))>0
    AND NOT EXISTS(SELECT 1 FROM task_drafts d WHERE d.threadId=t.id)
    ORDER BY (kind='main') DESC,lastActivity DESC,t.id LIMIT ? OFFSET ?`)
    .all(state,instance,instance,Number(query.has('projectId')),project,title,limit,integer(query.get('offset'),0,Number.MAX_SAFE_INTEGER,0))
}

function historyScope(thread:any,model:Sharing){
  if(!readable(thread.state)||thread.instanceId!=='main')fail('无法读取此会话历史',403)
  if(model && !(thread.projectId?model.shareProject:model.sharePersonal))fail('当前模型未获准读取此范围的历史',403)
}

// Assistant text and summaries may derive from earlier attachments without a direct reference.
const modelHistoryFilter = `AND (? OR (m.role='user' AND COALESCE(json_array_length(m.refs),0)=0 AND COALESCE(json_array_length(m.data,'$.attachmentIds'),0)=0
  AND COALESCE(json_array_length(parent.refs),0)=0 AND COALESCE(json_array_length(parent.data,'$.attachmentIds'),0)=0))`
export function historySearch(db:DatabaseSync,current:any,model:Sharing,args:any){
  historyScope(current,model)
  const q=required(args.query,'搜索片段')
  if(q.length>512)fail('搜索片段过长')
  const items=db.prepare(`SELECT m.id,m.threadId,t.title,m.createdAt,m.role,
    substr(m.text,max(1,instr(lower(m.text),lower(?))-100),600) AS text
    ${historyRows} AND t.projectId IS ? AND instr(lower(m.text),lower(?))>0 ${modelHistoryFilter}
    ORDER BY m.rowid DESC LIMIT ?`).all(q,current.projectId,q,Number(model?.shareAttachments!==false),integer(args.limit,20,100))
  return {items}
}
export function historyRead(db:DatabaseSync,current:any,model:Sharing,args:any){
  historyScope(current,model)
  const target=getThread(db,required(args.threadId,'会话 ID'))
  if(!readable(target.state)||target.projectId!==current.projectId||target.instanceId!=='main')fail('会话不在可读范围',403)
  if(args.summary){
    const summary=model?.shareAttachments===false?null:one(db,`SELECT s.body,s.throughMessageId,s.updatedAt FROM thread_summaries s
      JOIN messages m ON m.id=s.throughMessageId WHERE s.threadId=? AND m.rowid>${afterReset}`,target.id)
    return {threadId:target.id,summary:summary??null}
  }
  const cursor=args.before?must(db,'SELECT rowid AS n FROM messages WHERE id=? AND threadId=?',required(args.before,'游标'),target.id).n:Number.MAX_SAFE_INTEGER
  const limit=integer(args.limit,20,100)
  const rows=db.prepare(`SELECT m.id,m.createdAt,m.role,m.text ${historyRows} AND t.id=? AND m.rowid<? ${modelHistoryFilter}
    ORDER BY m.rowid DESC LIMIT ?`).all(target.id,cursor,Number(model?.shareAttachments!==false),limit+1)
  const items=rows.slice(0,limit).reverse()
  return {threadId:target.id,items,nextBefore:rows.length>limit?items[0].id:null}
}

function modelSharing(dir:string):Sharing{
  const active=modelSettings(dir).activeId
  if(active.startsWith('plugin:'))return {sharePersonal:false,shareProject:false,shareAttachments:false}
  return selectedModel(dir)?.model
}
function targetSharing(db:DatabaseSync,dir:string,target:any):Sharing{
  if(target.instanceId==='main')return modelSharing(dir)
  const inst=must(db,'SELECT adapterKey,profileId FROM instances WHERE id=?',target.instanceId)
  return inst.adapterKey==='model-api'?selectedModel(dir,inst.profileId)?.model:undefined
}

type SharedItem={id:string;role:string;text:string;createdAt:string;attachments:{id:string;name:string}[]}
function checkSnapshot(db:DatabaseSync,dir:string,target:any,items:SharedItem[],sourceProjectId:string|null){
  const model=targetSharing(db,dir,target)
  if(model && !(target.projectId?model.shareProject:model.sharePersonal))fail('目标模型未获准读取此范围的资料',403)
  if(model && !(sourceProjectId?model.shareProject:model.sharePersonal))fail('目标模型未获准读取来源范围的资料',403)
  for(const item of items){
    for(const attachment of item.attachments){
      if(model?.shareAttachments===false)fail('目标模型未获准读取附件',403)
      const asset=homeRead(db,dir,'/attachments/'+encodeURIComponent(attachment.id),target.projectId,'meta=1')
      if(!target.projectId&&(asset.projectIds?.length||asset.endpointIds?.length))fail('附件尚未授权给个人范围',403)
    }
  }
}

export function shareThread(db:DatabaseSync,dir:string,sourceId:string,args:any,ownerTransfer=false){
  const source=getThread(db,sourceId)
  if(!readable(source.state))fail('来源会话已删除',410)
  if(Boolean(args.targetThreadId)===Boolean(args.newThread))fail('请选择一个分享目标')
  const draft=args.newThread
  const target=draft?{instanceId:required(draft.instanceId??'main','Bot ID'),projectId:Object.hasOwn(draft,'projectId')?draft.projectId:source.projectId,state:'active'}:
    getThread(db,required(args.targetThreadId,'目标会话 ID'))
  if(target.state!=='active'||target.id===source.id)fail('请选择其他活跃会话',409)
  const crossProject=target.projectId!==source.projectId
  if(crossProject&&(!ownerTransfer||!args.preview&&args.confirmCrossProject!==true))
    fail('跨范围分享须由本机所有者核对目标并明确确认',403)
  const selected=args.messageIds
  if(selected!==undefined&&(!Array.isArray(selected)||!selected.length||selected.some(id=>typeof id!=='string')||new Set(selected).size!==selected.length))
    fail('请选择有效且不重复的消息')
  const rows=db.prepare(`SELECT m.* FROM messages m WHERE m.threadId=? AND ${visibleMessage}
    AND m.rowid>${afterReset} AND NOT EXISTS(SELECT 1 FROM messages parent WHERE parent.threadId=m.threadId
      AND parent.id=COALESCE(json_extract(m.data,'$.replyTo'),json_extract(m.data,'$.communication.replyTo'))
      AND (parent.rowid<=${afterReset} OR parent.kind='deleted_message'))
    AND (? IS NULL OR m.id IN(SELECT value FROM json_each(?))) ORDER BY m.rowid`).iterate(sourceId,selected?1:null,JSON.stringify(selected??[]))
  const items:SharedItem[]=[]
  const model=targetSharing(db,dir,target)
  let size=0
  for(const row of rows){
    const m=unpack(row,['refs','data'])
    if(crossProject&&m.role!=='user')continue
    // Material snapshots can contain private paths and earlier shares. Only send ordinary chat text and authorized attachments.
    if((m.refs??[]).some((ref:any)=>ref.type!=='attachment'))continue
    if(model?.shareAttachments===false && m.role!=='user')continue
    const ids=new Set<string>([...(m.data?.attachmentIds??[]),...(m.refs??[]).map((r:any)=>r.id)])
    const attachments=[...ids].map(id=>({id,name:homeRead(db,dir,'/attachments/'+encodeURIComponent(id),source.projectId,'meta=1').name}))
    size+=Buffer.byteLength(m.text??'','utf8')
    if(size>2*1024*1024)fail('所选原文超过 2 MiB，请缩小范围',413)
    items.push({id:m.id,role:m.role,text:m.text,createdAt:m.createdAt,attachments})
  }
  if(!items.length||selected&&items.length!==selected.length)fail('所选消息包含无法分享或已重置的内容',403)
  checkSnapshot(db,dir,target,items,source.projectId)
  const result={sourceThreadId:source.id,sourceProjectId:source.projectId,sourceTitle:source.title,targetThreadId:target.id??null,crossProject,items}
  if(args.preview===true)return result
  if(draft)result.targetThreadId=createThread(db,dir,{instanceId:target.instanceId,projectId:target.projectId,title:draft.title??source.title}).id
  const shareId=message(db,result.targetThreadId,'system','shared_context','来自「'+source.title+'」的 '+items.length+' 条分享资料',result)
  db.prepare('INSERT INTO thread_shares(messageId,targetThreadId) VALUES(?,?)').run(shareId,result.targetThreadId)
  return {...result,shareId}
}

export function pendingShareRefs(db:DatabaseSync,threadId:string){
  return db.prepare("SELECT 'share' AS type,messageId AS id FROM thread_shares WHERE targetThreadId=? AND sentWith IS NULL ORDER BY rowid")
    .all(threadId) as {type:'share',id:string}[]
}
export function readShareMaterial(db:DatabaseSync,dir:string,threadId:string,shareId:string){
  const row=must(db,`SELECT m.data FROM thread_shares s JOIN messages m ON m.id=s.messageId
    WHERE s.targetThreadId=? AND s.messageId=? AND m.kind='shared_context'`,threadId,shareId)
  const snapshot=JSON.parse(row.data),target=getThread(db,threadId)
  checkSnapshot(db,dir,target,snapshot.items,snapshot.sourceProjectId??null)
  return {type:'share',id:shareId,text:JSON.stringify({sourceThreadId:snapshot.sourceThreadId,sourceTitle:snapshot.sourceTitle,items:snapshot.items}),
    attachmentIds:[...new Set<string>(snapshot.items.flatMap((item:SharedItem)=>item.attachments.map(a=>a.id)))]}
}
export function markSharesSent(db:DatabaseSync,threadId:string,refs:{type:string;id:string}[],messageId:string){
  const mark=db.prepare('UPDATE thread_shares SET sentWith=? WHERE targetThreadId=? AND messageId=? AND sentWith IS NULL')
  for(const ref of refs)if(ref.type==='share')mark.run(messageId,threadId,ref.id)
}

export function threadImpact(db:DatabaseSync,key:string){
  const tasks=db.prepare('SELECT t.id,t.status,t.workThreadId,l.relation FROM tasks t JOIN task_threads l ON l.taskId=t.id WHERE l.threadId=?').all(key)
  const runs=db.prepare('SELECT id,status FROM runs WHERE threadId=? OR taskId IN(SELECT taskId FROM task_threads WHERE threadId=?)').all(key,key)
  const jobs=db.prepare("SELECT id,status FROM chat_jobs WHERE threadId=? AND status IN ('queued','working','awaiting_approval','budget_paused')").all(key)
  const held=one(db,"SELECT count(*) AS n FROM commands WHERE threadId=? AND status IN ('held','waiting','uncertain','sent','queued','received') AND (status IN ('held','waiting','uncertain') OR runId IN(SELECT id FROM runs WHERE status NOT IN ('completed','failed','blocked','cancelled')))",key).n
  const shares=one(db,"SELECT COUNT(*) n FROM messages WHERE kind='shared_context' AND (threadId=? OR json_extract(data,'$.sourceThreadId')=?)",key,key).n
  return {tasks,runs,jobs,shares,held,canPurge:getThread(db,key).kind!=='main'&&!jobs.length&&!held&&runs.every(r=>['completed','failed','blocked','cancelled'].includes(String(r.status))),
    scope:'仅清理本话题的工作台聊天缓存。任务、交付、来源以外的快照、长期记忆、导出及原生会话单独保留。'}
}

export function nativeLifecycle(db:DatabaseSync,dir:string,thread:any,action:'fork'|'archive'|'unarchive'|'delete',title?:string,actor='user'){
  const inst=must(db,'SELECT * FROM instances WHERE id=?',thread.instanceId)
  if(!thread.sessionId||!JSON.parse(inst.capabilities||'{}').nativeActions?.includes(action)){
    if(action==='fork'||action==='delete'||action==='unarchive'&&thread.nativeArchived)fail('此连接器未提供该原生会话操作',409)
    return null
  }
  if(!inst.online)fail('原生实例离线，无法同步此操作',409)
  assertBotAllowed(db,inst.id,actor==='user'?'direct':'delegate',thread.projectId)
  const active=one(db,"SELECT id FROM runs WHERE threadId=? AND status NOT IN ('completed','failed','blocked','cancelled')",thread.id)
  if(active){
    if(action==='archive')return null
    fail('会话有未结束或待核对的运行',409)
  }
  const target=action==='fork'?createThread(db,dir,{instanceId:inst.id,projectId:thread.projectId,title:title||thread.title+' · 分支'}):thread
  const runId=id(),commandId=id(),created=now()
  db.prepare("INSERT INTO runs(id,threadId,instanceId,status,createdAt) VALUES(?,?,?,'queued',?)").run(runId,target.id,inst.id,created)
  const payload={nativeOperation:{action,sourceThreadId:thread.id,sourceSessionId:thread.sessionId},...(actor==='user'?{}:{communication:{sender:{kind:'main_bot',id:'main'}}})}
  db.prepare("INSERT INTO commands(id,threadId,runId,instanceId,kind,payload,status,createdAt) VALUES(?,?,?,?,'prepare',?,'queued',?)")
    .run(commandId,target.id,runId,inst.id,JSON.stringify(payload),created)
  changed(db,'thread',{threadId:target.id,runId})
  return {...target,runId,commandId,scope:'native_pending'}
}

export function threadLifecycle(db:DatabaseSync,key:string,b:any,dir=''){
  const thread=getThread(db,key)
  if(thread.state==='purged')fail('本地聊天缓存已永久清理',410)
  if(thread.kind==='main'&&['archive','delete','purge'].includes(b.action))fail('固定主会话无法归档或删除',409)
  const updateState=(state:string)=>db.prepare('UPDATE threads SET state=? WHERE id=?').run(state,key)
  if(one(db,`SELECT 1 FROM commands c JOIN runs r ON r.id=c.runId WHERE (c.threadId=? OR json_extract(c.payload,'$.nativeOperation.sourceThreadId')=?)
    AND json_extract(c.payload,'$.nativeOperation.action') IS NOT NULL AND r.status NOT IN ('completed','cancelled','failed','blocked')`,key,key))
    fail('原生会话操作仍在处理或等待核对',409)
  switch(b.action){
    case 'markInvalid': {
      if(thread.kind!=='native'||!thread.sessionId||b.sessionId!==thread.sessionId||b.confirm!==true||!threadImpact(db,key).canPurge)
        fail('须先核对原生会话、所有运行和送达状态',409)
      const reason=required(b.reason,'原生失效依据').slice(0,500)
      db.prepare("UPDATE threads SET nativeInvalid=?,state='archived' WHERE id=?").run(reason,key)
      break
    }
    case 'replaceNative': {
      if(thread.kind!=='native'||!thread.nativeInvalid||!readable(thread.state)||!threadImpact(db,key).canPurge)
        fail('请先核对并标记旧绑定失效',409)
      assertBotAllowed(db,thread.instanceId,'direct',thread.projectId)
      const target=createThread(db,dir,{instanceId:thread.instanceId,projectId:thread.projectId,title:b.title||thread.title+' · 接续'})
      message(db,target.id,'system','activity','接续已失效的原生会话',{replacesThreadId:key,oldSessionId:thread.sessionId})
      message(db,key,'system','activity','已建立替代话题',{replacementThreadId:target.id})
      if(b.messageIds)shareThread(db,dir,key,{messageIds:b.messageIds,targetThreadId:target.id})
      return {...target,scope:'workbench',replacesThreadId:key}
    }
    case 'setMain': {
      const previous=mainThread(db)
      if(b.confirm!==true||b.previousMainId!==previous.id||thread.state!=='active'||thread.instanceId!=='main'||thread.projectId||thread.kind!=='side')
        fail('请核对原主会话并明确选择个人侧聊',409)
      db.prepare("UPDATE threads SET kind='side' WHERE id=?").run(previous.id)
      db.prepare("UPDATE threads SET kind='main',source='owner_selected' WHERE id=?").run(key)
      changed(db,'thread',{threadId:previous.id,action:'setMain'})
      break
    }
    case 'deleteNative':
      if(thread.state!=='deleted'||b.confirm!==true||b.sessionId!==thread.sessionId||thread.nativeInvalid||!threadImpact(db,key).canPurge)
        fail('请核对原生绑定、关联运行和删除范围并明确确认',409)
      return nativeLifecycle(db,dir,thread,'delete')
    case 'fork': {
      if(!readable(thread.state)||thread.instanceId==='main')fail('请选择可读取的原生会话',409)
      return nativeLifecycle(db,dir,thread,'fork',b.title)
    }
    case 'rename': {
      const title=required(b.title,'会话名称')
      if(title.length>120)fail('会话名称最多 120 个字符')
      if(!readable(thread.state))fail('请先恢复会话',409)
      db.prepare('UPDATE threads SET title=? WHERE id=?').run(title,key)
      break
    }
    case 'archive':
      if(!readable(thread.state))fail('请先恢复会话',409)
      if(thread.state==='active'&&thread.sessionId){
        const queued=nativeLifecycle(db,dir,thread,'archive')
        if(queued)return queued
      }
      updateState('archived')
      break
    case 'restore':
      if(thread.nativeArchived)return nativeLifecycle(db,dir,thread,'unarchive')
      updateState('active');break
    case 'delete':updateState('deleted');break
    case 'purge': {
      if(thread.state!=='deleted'||b.confirm!==true)fail('请先移到最近删除，核对影响并明确确认清理',409)
      if(!threadImpact(db,key).canPurge)fail('尚有未结束、待核对或挂起的操作',409)
      db.prepare('DELETE FROM thread_shares WHERE targetThreadId=?').run(key)
      db.prepare("DELETE FROM memory_candidates WHERE threadId=?").run(key)
      db.prepare("DELETE FROM thread_summaries WHERE threadId=?").run(key)
      db.prepare("UPDATE messages SET kind='deleted_message',text='',refs='[]',data='{}' WHERE threadId=?").run(key)
      db.prepare("UPDATE commands SET payload='{}',detail=NULL WHERE threadId=?").run(key)
      db.prepare("UPDATE chat_jobs SET operation=NULL,checkpoint=NULL,inFlight=NULL WHERE threadId=?").run(key)
      // Preserve request signatures so a retry can never execute a previously applied write again.
      db.prepare(`UPDATE requests SET result=json_object('status','previously_applied','threadId',?)
        WHERE json_extract(result,'$.targetThreadId')=? AND json_type(result,'$.items')='array'`).run(key,key)
      db.prepare("UPDATE threads SET state='purged',title='已清理会话',contextRevision=contextRevision+1 WHERE id=?").run(key)
      break
    }
    case 'reset': {
      if(!readable(thread.state)||thread.instanceId!=='main')fail('此会话不支持本地上下文重置',409)
      const last=one(db,'SELECT id FROM messages WHERE threadId=? ORDER BY rowid DESC LIMIT 1',key)
      if(last)db.prepare(`INSERT INTO thread_context_resets(threadId,throughMessageId) VALUES(?,?) ON CONFLICT(threadId)
        DO UPDATE SET throughMessageId=excluded.throughMessageId,version=version+1`).run(key,last.id)
      db.prepare('DELETE FROM thread_summaries WHERE threadId=?').run(key)
      db.prepare('DELETE FROM thread_shares WHERE targetThreadId=? AND sentWith IS NULL').run(key)
      break
    }
    case 'deleteMessage': {
      if(!readable(thread.state)||thread.instanceId!=='main')fail('只支持清理小毛球会话中的消息',409)
      const mid=required(b.messageId,'消息 ID')
      must(db,"SELECT id FROM messages WHERE threadId=? AND id=? AND kind IN ('message','shared_context','task_update')",key,mid)
      if(one(db,"SELECT id FROM chat_jobs WHERE messageId=? AND status IN ('working','queued','awaiting_approval','budget_paused')",mid))fail('请先停止这条消息的生成',409)
      db.prepare("UPDATE chat_jobs SET operation=NULL,checkpoint=NULL,inFlight=NULL WHERE messageId=?").run(mid)
      db.prepare('DELETE FROM thread_summaries WHERE threadId=?').run(key)
      db.prepare('DELETE FROM memory_candidates WHERE messageId=?').run(mid)
      db.prepare('DELETE FROM thread_shares WHERE messageId=?').run(mid)
      db.prepare(`UPDATE messages SET kind='deleted_message',text='',refs='[]',data='{}'
        WHERE threadId=? AND (id=? OR (kind='tool' AND json_extract(data,'$.replyTo')=?))`).run(key,mid,mid)
      db.prepare('UPDATE threads SET contextRevision=contextRevision+1 WHERE id=?').run(key)
      break
    }
    default:fail('未知会话操作')
  }
  changed(db,'thread',{threadId:key,action:b.action})
  return {...getThread(db,key),scope:'workbench'}
}
export function exportThread(db:DatabaseSync,key:string){
  const thread=getThread(db,key)
  if(!readable(thread.state))fail('请先恢复会话',409)
  return {thread,scope:'workbench',messages:messages(db,key).filter(m=>m.kind!=='deleted_message'&&m.kind!=='tool'&&m.data?.communication?.visibility!=='bot_internal')
    .map(({id,role,kind,text,createdAt,data})=>({id,role,kind,text,createdAt,...(kind==='shared_context'?{items:data.items}:{})}))}
}
