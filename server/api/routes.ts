import type { DatabaseSync } from 'node:sqlite'
import { homeApi } from '../home/index.ts'
import { id, required, changed, fail, one, must, unpack } from '../db/index.ts'
import { createThread, draftDelegate, delegate, sendInput, control, reconcileRun, reportCommunication, taskCommunications, getThread, latestRun, message, messages, messagePage, hasRunArtifacts, taskView, reviewDelivery, modelView, selectModel, prepareModels, importNativeSession } from '../tasks/index.ts'
import { hash,secret } from './auth.ts'
import { persona, savePersona } from '../chat/persona.ts'
import { modelSettings, updateModelSettings } from '../chat/model-settings.ts'
import { chatPolicy, saveChatPolicy } from '../chat/tools.ts'

export function route(db:DatabaseSync,ctx:any){
  const {method,path,body:b,dataDir,principal,localRequest,query}=ctx
  const [,area,key,sub]=path.split('/')
  if(area==='runs'&&key&&sub==='communication'&&method==='POST'){
    if(!principal.runPermission||principal.id!=='run:'+key)fail('仅本运行的工作 Bot 可提交此通信',403)
    return reportCommunication(db,dataDir,key,principal.projects[0],b)
  }
  if(area==='projects'&&key&&sub==='workspaces'){
    if(!principal.owner)fail('仅所有者可配置执行工作区',403)
    must(db,'SELECT id FROM projects WHERE id=?',key)
    if(method==='POST'){
      const instance=must(db,'SELECT * FROM instances WHERE id=?',required(b.instanceId,'instanceId'))
      if(required(b.workspaceRef,'workspaceRef')!==instance.workspaceRef)fail('执行实例的工作区与选择不一致',409)
      if(b.allowAgentAccess!==undefined && typeof b.allowAgentAccess!=='boolean')fail('allowAgentAccess 须为布尔值')
      const permission=b.agentPermission??'read'
      if(!['read','append','manage'].includes(permission))fail('无效的运行资料权限')
      db.prepare(`INSERT INTO project_workspaces(projectId,instanceId,allowAgentAccess,agentPermission) VALUES(?,?,?,?)
        ON CONFLICT(projectId,instanceId) DO UPDATE SET allowAgentAccess=excluded.allowAgentAccess,agentPermission=excluded.agentPermission`).run(key,instance.id,b.allowAgentAccess===true?1:0,permission)
      db.prepare('DELETE FROM run_grants WHERE projectId=? AND instanceId=? AND (?=0 OR permission<>?)').run(key,instance.id,b.allowAgentAccess===true?1:0,permission)
      changed(db,'home',{projectId:key,path})
    }
    if(method==='DELETE'){
      const instanceId=required(b.instanceId,'instanceId')
      db.prepare('DELETE FROM project_workspaces WHERE projectId=? AND instanceId=?').run(key,instanceId)
      db.prepare('DELETE FROM run_grants WHERE projectId=? AND instanceId=?').run(key,instanceId)
      changed(db,'home',{projectId:key,path})
    }
    if(['GET','POST','DELETE'].includes(method))return {items:db.prepare('SELECT i.id AS instanceId,i.name,i.nodeId,i.profileId,i.workspaceRef,p.allowAgentAccess,p.agentPermission FROM project_workspaces p JOIN instances i ON p.instanceId=i.id WHERE p.projectId=? ORDER BY i.name').all(key)}
  }
  if(['projects','spaces','collections','modules','records','sources','attachments','submissions','search'].includes(area)){
    const result=homeApi(db,ctx)
    if(result!==undefined){
      if(method!=='GET' && b.mode!=='preview')changed(db,'home',{path,projectId:b.projectId??(area==='projects'?key:null)})
      return result
    }
  }
  if(!principal.owner)fail('此授权仅允许访问指定项目资料',403)
  if(path==='/events/latest'&&method==='GET')return {cursor:one(db,'SELECT COALESCE(MAX(cursor),0) c FROM events').c}
  if(path==='/chat/persona' && ['GET','POST'].includes(method)){
    if(!localRequest)fail('主聊人格限本机配置',403)
    return method==='GET'?persona(dataDir):savePersona(dataDir,b)
  }
  if(['/chat/models','/chat/policy'].includes(path)&&['GET','POST'].includes(method)){
    if(!localRequest)fail('主聊配置限本机所有者操作',403)
    if(path==='/chat/models')return method==='GET'?modelSettings(dataDir):updateModelSettings(dataDir,b)
    return method==='GET'?chatPolicy(dataDir):saveChatPolicy(dataDir,b)
  }
  if(path==='/chat/cancel'&&method==='POST'){
    if(!localRequest)fail('主聊控制限本机',403)
    const job=must(db,"SELECT * FROM chat_jobs WHERE messageId=? AND status IN ('queued','working')",required(b.messageId,'messageId'))
    db.prepare("UPDATE chat_jobs SET status='cancelled' WHERE id=?").run(job.id)
    const prior=one(db,`SELECT 1 FROM messages WHERE threadId=? AND kind='tool'
      AND json_extract(data,'$.replyTo')=? AND json_extract(data,'$.ok')=1`,job.threadId,job.messageId)
    message(db,job.threadId,'system','activity',prior?'已停止主聊生成。请查看本轮已执行的工具操作。':'已取消主聊生成。',{replyTo:job.messageId})
    changed(db,'chat',{threadId:job.threadId,messageId:job.messageId,status:'cancelled'})
    return {jobId:job.id,messageId:job.messageId,status:'cancelled'}
  }
  function executionAccess(instanceId:string){
    const adapter=one(db,'SELECT adapterKey FROM instances WHERE id=?',instanceId)?.adapterKey
    if(!localRequest && (adapter==='codex'||instanceId==='main'))fail('个人 ChatGPT 登录只支持同机使用工作台',403)
  }
  if(area==='instances'&&key&&sub==='sessions'&&method==='POST'){
    if(!localRequest)fail('外部会话导入限本机所有者',403)
    return importNativeSession(db,dataDir,key,b)
  }
  if(path==='/grants'&&method==='POST'){
    const projectId=required(b.projectId,'projectId')
    must(db,'SELECT id FROM projects WHERE id=?',projectId)
    const token=secret(),key=id()
    const days=b.expiresInDays??30
    if(!Number.isInteger(days)||days<1||days>365)fail('expiresInDays 须为 1 到 365 的整数')
    const expiresAt=new Date(Date.now()+days*86400000).toISOString()
    db.prepare('INSERT INTO grants(tokenHash,id,projectId,expiresAt) VALUES(?,?,?,?)').run(hash(token),key,projectId,expiresAt)
    return {id:key,projectId,token,expiresAt}
  }
  if(area==='grants' && method==='DELETE' && key){
    db.prepare('DELETE FROM grants WHERE id=?').run(key)
    return {id:key,revoked:true}
  }
  if(path==='/instances'&&method==='GET')return [{id:'main',name:'小毛球',online:true,availableActions:['message','delegate']},...db.prepare('SELECT * FROM instances ORDER BY name').all().map(r=>({...unpack(r,['availableActions','capabilities']),online:!!r.online}))]
  if(path==='/threads'&&method==='POST')return createThread(db,dataDir,b)
  if(path==='/threads'&&method==='GET')return db.prepare('SELECT t.* FROM threads t LEFT JOIN task_drafts d ON d.threadId=t.id WHERE d.threadId IS NULL ORDER BY t.rowid DESC').all()
  if(area==='threads' && key){
    const thread=getThread(db,key)
    if(!sub && method==='GET'){
      const taskData=thread.taskId?taskView(db,thread.taskId):{run:latestRun(db,key),commands:db.prepare('SELECT * FROM commands WHERE threadId=? ORDER BY rowid').all(key).map(c=>unpack(c,['payload']))}
      const page=query.has('messageLimit')?messagePage(db,key,null,query.get('messageLimit')):{messages:messages(db,key)}
      const submittedArtifacts=!!taskData.run&&hasRunArtifacts(db,key,taskData.run.id)
      const settings=thread.instanceId==='main'?modelSettings(dataDir):null
      const mainChat=settings?{
        pending:db.prepare("SELECT messageId,status FROM chat_jobs WHERE threadId=? AND status IN ('queued','working') ORDER BY id").all(thread.id),
        model:settings.models.find(m=>m.id===settings.activeId)?.name
      }:undefined
      return {thread,...page,...taskData,submittedArtifacts,mainChat,model:modelView(db,thread),cursor:one(db,'SELECT COALESCE(MAX(cursor),0) c FROM events').c}
    }
    if(sub==='messages'&&method==='GET')return messagePage(db,key,query.get('before'),query.get('limit'))
    if(sub==='messages'&&method==='POST'){executionAccess(thread.instanceId);return sendInput(db,dataDir,thread,b)}
    if(sub==='model'&&method==='POST'){
      executionAccess(thread.instanceId)
      return b.prepare===true?prepareModels(db,thread):selectModel(db,thread,b.modelId)
    }
  }
  if(path==='/tasks/draft'&&method==='POST'){executionAccess(required(b.instanceId,'instanceId'));return draftDelegate(db,dataDir,b)}
  if(path==='/tasks'&&method==='POST'){executionAccess(required(b.instanceId,'instanceId'));return delegate(db,dataDir,b)}
  if(area==='tasks'&&key&&sub==='review'&&method==='POST')return reviewDelivery(db,key,b)
  if(area==='tasks'&&key&&sub==='communication'&&method==='GET')return taskCommunications(db,key)
  if(area==='tasks'&&key&&method==='GET')return taskView(db,key)
  if(area==='runs'&&key&&sub==='recovery'&&method==='POST')return reconcileRun(db,key,b)
  if(area==='runs'&&key&&sub==='commands'&&method==='POST'){
    executionAccess(must(db,'SELECT instanceId FROM runs WHERE id=?',key).instanceId)
    return control(db,dataDir,key,b)
  }
  fail('接口不存在',404)
}
