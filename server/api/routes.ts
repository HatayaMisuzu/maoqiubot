import type { DatabaseSync } from 'node:sqlite'
import { homeApi } from '../home/index.ts'
import { id, required, changed, fail, one, must, unpack } from '../db/index.ts'
import { createThread, draftDelegate, delegate, sendInput, control, getThread, latestRun, messages, taskView, reviewDelivery, modelView, selectModel, prepareModels } from '../tasks/index.ts'
import { hash,secret } from './auth.ts'

export function route(db:DatabaseSync,ctx:any){
  const {method,path,body:b,dataDir,principal,localRequest}=ctx
  const [,area,key,sub]=path.split('/')
  if(area==='projects'&&key&&sub==='workspaces'){
    if(!principal.owner)fail('仅所有者可配置执行工作区',403)
    must(db,'SELECT id FROM projects WHERE id=?',key)
    if(method==='POST'){
      const instance=must(db,'SELECT * FROM instances WHERE id=?',required(b.instanceId,'instanceId'))
      if(required(b.workspaceRef,'workspaceRef')!==instance.workspaceRef)fail('执行实例的工作区与选择不一致',409)
      if(b.allowAgentAccess!==undefined && typeof b.allowAgentAccess!=='boolean')fail('allowAgentAccess 须为布尔值')
      db.prepare('INSERT INTO project_workspaces(projectId,instanceId,allowAgentAccess) VALUES(?,?,?) ON CONFLICT(projectId,instanceId) DO UPDATE SET allowAgentAccess=excluded.allowAgentAccess').run(key,instance.id,b.allowAgentAccess===true?1:0)
      if(b.allowAgentAccess!==true)db.prepare('DELETE FROM run_grants WHERE projectId=? AND instanceId=?').run(key,instance.id)
      changed(db,'home',{projectId:key,path})
    }
    if(['GET','POST'].includes(method))return {items:db.prepare('SELECT i.id AS instanceId,i.name,i.nodeId,i.profileId,i.workspaceRef,p.allowAgentAccess FROM project_workspaces p JOIN instances i ON p.instanceId=i.id WHERE p.projectId=? ORDER BY i.name').all(key)}
  }
  if(['projects','spaces','collections','modules','records','sources','attachments','submissions','search'].includes(area)){
    const result=homeApi(db,ctx)
    if(result!==undefined){
      if(method!=='GET' && b.mode!=='preview')changed(db,'home',{path,projectId:b.projectId??(area==='projects'?key:null)})
      return result
    }
  }
  if(!principal.owner)fail('此授权仅允许访问指定项目资料',403)
  function executionAccess(instanceId:string){
    const adapter=one(db,'SELECT adapterKey FROM instances WHERE id=?',instanceId)?.adapterKey
    if(!localRequest && (adapter==='codex'||instanceId==='main'))fail('个人 ChatGPT 登录只支持同机使用工作台',403)
  }
  if(path==='/grants'&&method==='POST'){
    const projectId=required(b.projectId,'projectId')
    must(db,'SELECT id FROM projects WHERE id=?',projectId)
    const token=secret(),key=id()
    db.prepare('INSERT INTO grants VALUES(?,?,?)').run(hash(token),key,projectId)
    return {id:key,projectId,token}
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
      return {thread,messages:messages(db,key),...taskData,model:modelView(db,thread),cursor:one(db,'SELECT COALESCE(MAX(cursor),0) c FROM events').c}
    }
    if(sub==='messages'&&method==='POST'){executionAccess(thread.instanceId);return sendInput(db,dataDir,thread,b)}
    if(sub==='model'&&method==='POST'){
      executionAccess(thread.instanceId)
      return b.prepare===true?prepareModels(db,thread):selectModel(db,thread,b.modelId)
    }
  }
  if(path==='/tasks/draft'&&method==='POST'){executionAccess(required(b.instanceId,'instanceId'));return draftDelegate(db,dataDir,b)}
  if(path==='/tasks'&&method==='POST'){executionAccess(required(b.instanceId,'instanceId'));return delegate(db,dataDir,b)}
  if(area==='tasks'&&key&&sub==='review'&&method==='POST')return reviewDelivery(db,key,b)
  if(area==='tasks'&&key&&method==='GET')return taskView(db,key)
  if(area==='runs'&&key&&sub==='commands'&&method==='POST'){
    executionAccess(must(db,'SELECT instanceId FROM runs WHERE id=?',key).instanceId)
    return control(db,dataDir,key,b)
  }
  fail('接口不存在',404)
}
