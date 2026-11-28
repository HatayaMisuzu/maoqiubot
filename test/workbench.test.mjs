import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import {startServer} from '../server/index.ts'
import {transfer} from '../scripts/backup.ts'
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function waitFor(fn){for(let i=0;i<150;i++){const v=await fn();if(v)return v;await sleep(15)}throw Error('condition timed out')}
test('Origin errors are client responses, query-aware retries stay stable, and grant tokens are not cached',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'maoqiu-request-boundaries-'))
  let app=startServer({port:0,dataDir:temp,chat:false})
  try{
    await once(app.server,'listening')
    const base=()=> 'http://127.0.0.1:'+app.server.address().port+'/api/v1'
    const send=(path,body,headers={})=>fetch(base()+path,{method:'POST',headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
    assert.equal((await send('/projects',{name:'malformed'},{Origin:'not a url'})).status,400)
    assert.equal((await send('/projects',{name:'opaque'},{Origin:'null'})).status,403)
    const first=await send('/projects?ref=a&id=b',{name:'查询签名',requestId:'query-signature'})
    assert.equal(first.status,200)
    const reordered=await send('/projects?id=b&ref=a',{name:'查询签名',requestId:'query-signature'})
    assert.equal(reordered.status,200)
    assert.deepEqual(await reordered.json(),await first.json())
    assert.equal((await send('/projects?ref=a&id=c',{name:'查询签名',requestId:'query-signature'})).status,409)
    const project=await (await send('/projects',{name:'授权项目'})).json()
    const issued=await send('/grants',{projectId:project.id,requestId:'grant-token-test'})
    assert.equal(issued.status,200)
    const grant=await issued.json()
    assert.equal(typeof grant.token,'string')
    assert.equal((await send('/grants',{projectId:project.id,requestId:'grant-token-test'})).status,409)
    const cached=app.db.prepare('SELECT result FROM requests WHERE requestId=?').get('grant-token-test').result
    assert.equal(JSON.parse(cached)._sensitiveResult,'grant-token')
    assert.equal(JSON.parse(cached).token,undefined)
    app.db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run('owner','legacy-sensitive','legacy-signature',JSON.stringify({id:'legacy',projectId:project.id,token:'synthetic-token',expiresAt:'2099-01-01T00:00:00Z'}))
    app.db.exec(`DROP TABLE desktop_codex_switch; DROP INDEX threads_native_binding;
      ALTER TABLE threads DROP COLUMN nativeRuntimeScopeId; PRAGMA user_version=8`)
    await app.close()
    app=startServer({port:0,dataDir:temp,chat:false})
    await once(app.server,'listening')
    const legacy=app.db.prepare('SELECT result FROM requests WHERE requestId=?').get('legacy-sensitive').result
    assert.deepEqual(JSON.parse(legacy),{_sensitiveResult:'grant-token'})
    const oversized=await fetch(base()+'/projects',{method:'POST',headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'},
      body:'{"name":"'+('x'.repeat(24*1024*1024))+'"}'})
    assert.equal(oversized.status,413)
    assert.match((await oversized.json()).error,/24 MiB/)
  }finally{if(app.server.listening)await app.close();rmSync(temp,{recursive:true,force:true})}
})
test('HTTP → authenticated node → project result → exact retry → restored snapshot',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'maoqiu-integration-'))
  let app=startServer({port:0,dataDir:join(temp,'live'),chat:false}),ws
  async function api(path,body,token=app.auth.cfg.ownerToken){
    const url='http://127.0.0.1:'+app.server.address().port+'/api/v1'+path
    const res=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body&&JSON.stringify(body)})
    return {status:res.status,data:await res.json()}
  }
  async function request(path,body,token){const r=await api(path,body,token);assert.equal(r.status,200,JSON.stringify(r.data));return r.data}
  const packets=[]
  async function connect(){
    ws=new WebSocket('ws://127.0.0.1:'+app.server.address().port+'/api/v1/node',{headers:{Authorization:'Bearer '+app.auth.cfg.nodes.local}})
    ws.on('message',raw=>packets.push(JSON.parse(raw)))
    await once(ws,'open')
    ws.send(JSON.stringify({type:'hello',nodeId:'local',instances:[{id:'fixture',name:'测试节点',adapterKey:'test',workspaceRef:temp,availableActions:['run','cancel','answer'],models:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}]}]}))
    await waitFor(async()=>(await request('/instances')).find(i=>i.id==='fixture'&&i.online))
  }
  const push=m=>ws.send(JSON.stringify(m))
  try{
    await once(app.server,'listening')
    await connect()
    const p=await request('/projects',{name:'光变资料'})
    assert.equal((await api('/threads',{projectId:p.id,instanceId:'fixture'})).status,409)
    assert.equal((await api('/projects/'+p.id+'/workspaces',{instanceId:'fixture',workspaceRef:'wrong'})).status,409)
    await request('/projects/'+p.id+'/workspaces',{instanceId:'fixture',workspaceRef:temp})
    const t=await request('/threads',{projectId:p.id})
    const forwarded=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/v1/threads/'+t.id+'/messages',{
      method:'POST',headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json',Forwarded:'for=192.0.2.9'},body:JSON.stringify({text:'远程个人登录执行'})
    })
    assert.equal(forwarded.status,403)
    const outside=await request('/projects',{name:'私人资料'})
    const grant=await request('/grants',{projectId:p.id})
    assert.equal((await api('/projects/'+outside.id+'/brief',null,grant.token)).status,403)
    assert.equal((await api('/threads',null,grant.token)).status,403)
    const a=await request('/attachments',{projectId:p.id,name:'notes.txt',data:'QUJD'})
    const b={originThreadId:t.id,instanceId:'fixture',projectId:p.id,goal:'整理资料',doneWhen:['核对原件'],attachmentIds:[a.id],requestId:'delegate'}
    const task=await request('/tasks',b)
    assert.deepEqual(await request('/tasks',b),task)
    assert.equal((await api('/tasks',{...b,goal:'其他'})).status,409)
    const command=await waitFor(()=>packets.find(m=>m.type==='command')?.command)
    assert.equal(command.runId,task.runId)
    assert.equal(command.payload.modelId,undefined)
    assert.equal(command.payload.homeAccess,undefined)
    assert.equal(command.workspaceRef,temp)
    assert.equal(command.projectId,p.id)
    assert.equal((await request('/attachments/'+a.id+'?commandId='+command.id,null,app.auth.cfg.nodes.local)).data,'QUJD')
    assert.equal((await api('/attachments/'+a.id+'?commandId=foreign',null,app.auth.cfg.nodes.local)).status,403)
    const event=(seq,kind,data)=>({type:'event',event:{key:'e'+seq,seq,instanceId:'fixture',runId:task.runId,commandId:command.id,kind,data}})
    push({type:'receipt',status:'received',commandId:command.id})
    push(event(1,'accepted',{sessionId:'native-session',nativeRunId:'turn-a'}))
    await waitFor(()=>packets.some(m=>m.key==='e1'))
    const waiting=await request('/threads/'+task.workThreadId+'/messages',{text:'检查附注'})
    assert.equal(waiting.status,'waiting')
    await request('/runs/'+task.runId+'/commands',{kind:'edit',text:'检查修订',commandId:waiting.commandId})
    await request('/runs/'+task.runId+'/commands',{kind:'withdraw',commandId:waiting.commandId})
    push(event(2,'message',{text:'发现待确认项'}))
    push(event(3,'model_state',{current:'alpha',sessionId:'native-session',options:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}]}))
    const completed=event(4,'completed',{})
    push(completed);await waitFor(()=>packets.some(m=>m.key==='e4'))
    ws.close();await once(ws,'close');await connect()
    push(completed);push(event(5,'accepted',{}));await waitFor(()=>packets.some(m=>m.key==='e5'))
    for(let n=0;n<3;n++)assert.equal((await request('/tasks/'+task.taskId)).task.status,'awaiting_review')
    const review=await request('/tasks/'+task.taskId+'/review',{runId:task.runId,checks:[{criterion:'核对原件',met:false,evidence:'原件尚待核对'}]})
    assert.equal(review.status,'partial')
    const snap=await request('/threads/'+task.workThreadId)
    assert.equal(snap.run.status,'completed');assert.equal(snap.thread.sessionId,'native-session')
    assert.equal(snap.messages.filter(m=>m.kind==='completed').length,1)
    assert.equal(snap.model.current,'alpha')
    const stream=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/v1/events?after='+(snap.cursor-1),{headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken}})
    const reader=stream.body.getReader();const part=new TextDecoder().decode((await reader.read()).value);await reader.cancel()
    assert.match(part,new RegExp('id: '+snap.cursor))
    assert.equal((await api('/threads/'+task.workThreadId+'/model',{modelId:'unknown'})).status,409)
    assert.equal((await request('/threads/'+task.workThreadId+'/model',{modelId:'beta'})).selected,'beta')
    const another=await request('/threads',{projectId:p.id,instanceId:'fixture'})
    assert.equal((await request('/threads/'+another.id)).model.selected,null)
    const timeline=(await request('/projects/'+p.id+'/timeline',null,grant.token)).items
    assert.equal(timeline.filter(r=>r.taskId===task.taskId).length,3)
    assert.equal(app.db.prepare('SELECT count(*) n FROM runs').get().n,1)
    assert.equal(app.db.prepare('SELECT count(*) n FROM chat_jobs').get().n,0)
    transfer(app.dataDir,join(temp,'backup'))
    transfer(join(temp,'backup'),join(temp,'restored'),true)
    ws.close();await once(ws,'close');await app.close()
    app=startServer({port:0,dataDir:join(temp,'restored'),chat:false});await once(app.server,'listening')
    assert.equal((await request('/tasks/'+task.taskId)).run.id,task.runId)
    assert.equal((await request('/threads/'+task.workThreadId)).model.selected,'beta')
    assert.equal((await request('/attachments/'+a.id)).data,'QUJD')
    assert.equal((await request('/spaces/'+p.spaceId+'/pages/'+p.pageId)).page.id,p.pageId)
    assert.deepEqual((await request('/projects/'+p.id+'/timeline',null,grant.token)).items,timeline)
  } finally {if(ws?.readyState===1)ws.close();await app.close();rmSync(temp,{recursive:true,force:true})}
})

test('Bot范围设置跨重连保留，多个任务共享原生线程并按taskId继续',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'maoqiu-task-routing-'))
  const app=startServer({port:0,dataDir:join(temp,'server'),chat:false})
  let ws
  async function request(path,body,expected=200){
    const res=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/v1'+path,{
      method:body?'POST':'GET',headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'},
      body:body&&JSON.stringify(body)
    })
    const data=await res.json()
    assert.equal(res.status,expected,JSON.stringify(data))
    return data
  }
  const packets=[]
  const connect=async()=>{
    ws=new WebSocket('ws://127.0.0.1:'+app.server.address().port+'/api/v1/node',{headers:{Authorization:'Bearer '+app.auth.cfg.nodes.local}})
    ws.on('message',raw=>packets.push(JSON.parse(raw)))
    await once(ws,'open')
    ws.send(JSON.stringify({type:'hello',nodeId:'local',instances:[{id:'fixture',name:'测试 Bot',adapterKey:'test',workspaceRef:temp,
      availableActions:['run','cancel','answer'],resume:true,history:false,sessionList:false}]}))
    await waitFor(async()=> (await request('/instances')).find(instance=>instance.id==='fixture'&&instance.online))
  }
  const finishRun=async(task,sessionId,turnId)=>{
    const command=await waitFor(()=>packets.find(frame=>frame.type==='command'&&frame.command.runId===task.runId)?.command)
    const event=(seq,kind,data)=>({type:'event',event:{key:turnId+'-'+seq,seq,instanceId:'fixture',runId:task.runId,commandId:command.id,kind,data}})
    ws.send(JSON.stringify(event(1,'accepted',{sessionId,nativeRunId:turnId})))
    ws.send(JSON.stringify(event(2,'message',{text:'result '+turnId})))
    ws.send(JSON.stringify(event(3,'completed',{text:'done'})))
    return waitFor(async()=>{
      const status=(await request('/tasks/'+task.taskId)).run?.status
      return status==='completed'?status:null
    })
  }
  try{
    await once(app.server,'listening')
    const project=await request('/projects',{name:'多任务路由项目'})
    await connect()
    await request('/projects/'+project.id+'/workspaces',{instanceId:'fixture',workspaceRef:temp})
    const direct=await request('/threads',{projectId:project.id,instanceId:'fixture'})
    const botSettings=await request('/instances/fixture/settings',{enabled:false})
    assert.equal(botSettings.enabled,false)
    await request('/threads/'+direct.id+'/messages',{text:'不得直聊'},409)
    ws.close();await once(ws,'close')
    await connect()
    assert.equal((await request('/instances')).find(instance=>instance.id==='fixture').enabled,false)
    await request('/instances/fixture/settings',{enabled:true,allowDirect:true,allowDelegate:true,allowedProjects:[project.id]})
    await request('/threads',{instanceId:'fixture'},403)
    const origin=await request('/threads',{projectId:project.id})
    const first=await request('/tasks',{originThreadId:origin.id,instanceId:'fixture',projectId:project.id,goal:'任务 A',routeReason:'继续既有原生会话'})
    await finishRun(first,'native-shared','turn-a')
    const second=await request('/tasks',{originThreadId:origin.id,instanceId:'fixture',projectId:project.id,goal:'任务 B',workThreadId:first.workThreadId,
      routeReason:'同一工作区的新目标'})
    assert.notEqual(second.taskId,first.taskId)
    assert.equal(second.workThreadId,first.workThreadId)
    await finishRun(second,'native-shared','turn-b')
    const continuation=await request('/tasks',{originThreadId:origin.id,instanceId:'fixture',projectId:project.id,taskId:first.taskId,
      goal:'复查任务 A',routeReason:'回到已完成的任务 A'})
    assert.equal(continuation.taskId,first.taskId)
    assert.equal(continuation.workThreadId,first.workThreadId)
    await finishRun(continuation,'native-shared','turn-a2')
    const viewA=await request('/tasks/'+first.taskId)
    const viewB=await request('/tasks/'+second.taskId)
    assert.equal(viewA.run.id,continuation.runId)
    assert.equal(viewB.run.id,second.runId)
    assert.deepEqual(app.db.prepare('SELECT relation FROM task_threads WHERE taskId=? ORDER BY relation').all(first.taskId).map(row=>row.relation),['origin','work'])
    const communications=await request('/tasks/'+first.taskId+'/communication')
    assert.ok(communications.items.every(message=>app.db.prepare('SELECT taskId FROM messages WHERE id=?').get(message.id)?.taskId===first.taskId))
    assert.equal((await request('/threads/'+first.workThreadId)).thread.sessionId,'native-shared')
  } finally {
    if(ws?.readyState===1)ws.close()
    await app.close()
    rmSync(temp,{recursive:true,force:true})
  }
})

test('native runtime scope is pinned to a registered instance ID',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'maoqiu-runtime-scope-'))
  const app=startServer({port:0,dataDir:temp,chat:false})
  let ws
  const connect=async runtimeScopeId=>{
    ws=new WebSocket('ws://127.0.0.1:'+app.server.address().port+'/api/v1/node',{
      headers:{Authorization:'Bearer '+app.auth.cfg.nodes.local}
    })
    await once(ws,'open')
    ws.send(JSON.stringify({type:'hello',nodeId:'local',instances:[{id:'scope-fixture',name:'scope fixture',adapterKey:'test',
      workspaceRef:temp,availableActions:['run'],runtimeScopeId}]}))
  }
  try{
    await once(app.server,'listening')
    const first='a'.repeat(64),second='b'.repeat(64)
    await connect(first)
    await waitFor(async()=>app.db.prepare('SELECT 1 FROM instances WHERE id=? AND online=1').get('scope-fixture'))
    assert.equal(app.db.prepare('SELECT runtimeScopeId FROM instances WHERE id=?').get('scope-fixture').runtimeScopeId,first)
    ws.close();await once(ws,'close')
    await connect(second)
    const [code]=await once(ws,'close')
    assert.equal(code,1008)
    assert.equal(app.db.prepare('SELECT runtimeScopeId FROM instances WHERE id=?').get('scope-fixture').runtimeScopeId,first)
    assert.equal(app.db.prepare('SELECT online FROM instances WHERE id=?').get('scope-fixture').online,0)
  }finally{
    if(ws?.readyState===WebSocket.OPEN)ws.close()
    await app.close();rmSync(temp,{recursive:true,force:true})
  }
})

test('native model setup and dispatch reuse one scoped session, and held input resumes explicitly',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'maoqiu-model-'))
  const app=startServer({port:0,dataDir:temp,chat:false})
  const packets=[]
  let ws
  async function api(path,body,status=200,method=body?'POST':'GET',token=app.auth.cfg.ownerToken){
    const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/v1'+path,{
      method,
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:body&&JSON.stringify(body)
    })
    const data=await response.json()
    assert.equal(response.status,status,JSON.stringify(data))
    return data
  }
  async function emit(command,seq,kind,data={}){
    const key=command.id+'#'+seq
    ws.send(JSON.stringify({type:'event',event:{commandId:command.id,runId:command.runId,instanceId:command.instanceId,key,seq,kind,data}}))
    await waitFor(()=>packets.some(p=>p.type==='ack'&&p.key===key))
  }
  async function receipt(command,status,detail){
    ws.send(JSON.stringify({type:'receipt',status,commandId:command.id,detail}))
    await waitFor(()=>packets.some(p=>p.type==='receipt_ack'&&p.commandId===command.id&&p.status===status))
  }
  const findCommand=predicate=>waitFor(()=>packets.find(p=>p.type==='command'&&predicate(p.command))?.command)
  try {
    await once(app.server,'listening')
    ws=new WebSocket('ws://127.0.0.1:'+app.server.address().port+'/api/v1/node',{headers:{Authorization:'Bearer '+app.auth.cfg.nodes.local}})
    ws.on('message',raw=>packets.push(JSON.parse(raw)))
    await once(ws,'open')
    ws.send(JSON.stringify({type:'hello',nodeId:'local',instances:[{id:'native',name:'原生节点',adapterKey:'dsh',profileId:'acp',workspaceRef:temp,availableActions:['prepare','run','cancel','answer']}]}))
    await waitFor(async()=>(await api('/instances')).find(i=>i.id==='native'&&i.online))
    const project=await api('/projects',{name:'光谱'})
    const origin=await api('/threads',{projectId:project.id})
    await api('/projects/'+project.id+'/workspaces',{instanceId:'native',workspaceRef:temp})
    const otherOrigin=await api('/threads',{projectId:project.id})
    const args={originThreadId:origin.id,instanceId:'native',projectId:project.id}
    const draft=await api('/tasks/draft',args)
    assert.equal((await api('/tasks/draft',args)).id,draft.id)
    assert.equal((await api('/threads')).some(t=>t.id===draft.id),false)
    const path='/threads/'+draft.id
    await api(path+'/messages',{text:'草稿不可直接发送'},409)
    const first=await api(path+'/model',{prepare:true})
    const failed=await findCommand(c=>c.id===first.commandId)
    await emit(failed,1,'failed',{text:'原生目录暂时不可用'})
    assert.equal((await api(path)).model.previewError,'原生目录暂时不可用')
    const setup=await api(path+'/model',{prepare:true})
    const prepare=await findCommand(c=>c.id===setup.commandId)
    assert.equal(prepare.kind,'prepare')
    assert.equal(prepare.profileId,'acp')
    assert.equal(prepare.payload.text,undefined)
    await api('/tasks',{...args,workThreadId:draft.id,goal:'先读取模型'},409)
    const options=[{id:'[\"provider-a\",\"flash\"]',label:'Flash A'},{id:'[\"provider-b\",\"flash\"]',label:'Flash B'}]
    const sessionId='prepared-native-session'
    await emit(prepare,1,'accepted',{})
    assert.equal((await api(path)).run.status,'running')
    await emit(prepare,2,'model_state',{sessionId,current:options[0].id,options})
    await emit(prepare,3,'completed',{sessionId})
    const preflight=await api(path)
    assert.equal(preflight.thread.sessionId,sessionId)
    assert.equal(preflight.model.previewError,null)
    assert.equal(preflight.run.modelSetup,1)
    await api(path+'/model',{modelId:options[1].id})
    const beforeStaleSend=(await api(path)).messages.length
    await api(path+'/messages',{text:'使用过期模型快照',expectedModelId:options[0].id},409)
    assert.equal((await api(path)).messages.length,beforeStaleSend)
    await api('/tasks',{...args,originThreadId:otherOrigin.id,workThreadId:draft.id,goal:'不同发起话题'},409)
    const privateSource=(await api('/submissions',{source:{title:'私人原件',text:'不可跨项目转交'}})).source
    await api('/tasks',{...args,workThreadId:draft.id,goal:'越权引用',refs:[{type:'source',id:privateSource.id}]},403)
    const file=await api('/attachments',{projectId:project.id,name:'raw.txt',data:'QUJD'})
    const source=(await api('/submissions',{projectId:project.id,source:{title:'共享原件',text:'有来源的材料',author:'观测员',platform:'日志',attachmentIds:[file.id]}})).source
    assert.deepEqual((await api('/sources/'+source.id+'?projectId='+project.id)).attachmentIds,[file.id])
    await api('/sources/'+privateSource.id+'?projectId='+project.id,undefined,403)
    const body={...args,workThreadId:draft.id,goal:'整理材料',refs:[{type:'source',id:source.id}],attachmentIds:[file.id],requestId:'same-dispatch'}
    const task=await api('/tasks',body)
    assert.deepEqual(await api('/tasks',body),task)
    assert.equal(task.workThreadId,draft.id)
    assert.equal((await api('/threads')).find(t=>t.id===draft.id).title,'整理材料')
    const run=await findCommand(c=>c.kind==='run'&&c.runId===task.runId)
    assert.equal(run.payload.sessionId,sessionId)
    assert.equal(run.payload.modelId,options[1].id)
    const expectedMaterial={type:'source',id:source.id,text:'有来源的材料',title:'共享原件',author:'观测员',platform:'日志',url:null,createdAt:source.createdAt}
    assert.deepEqual(JSON.parse(run.payload.text).materials,[expectedMaterial])
    const nodeToken=app.auth.cfg.nodes.local
    const attachmentRoute='/attachments/'+file.id+'?commandId='+run.id
    assert.equal((await api(attachmentRoute,undefined,200,'GET',nodeToken)).data,'QUJD')
    await api('/attachments/'+file.id,{projectIds:[]},200,'PATCH')
    await api(attachmentRoute,undefined,403,'GET',nodeToken)
    assert.deepEqual((await api('/sources/'+source.id+'?projectId='+project.id)).attachmentIds,[])
    const original=(await api('/submissions',{projectId:project.id,source:{title:'只在另一节点',localRef:{nodeId:'other-machine',workspaceRef:temp,path:'foreign-local-only.txt'}}})).source
    const handoff=await api('/projects/'+project.id+'/records',{type:'handoff',body:'待接续',confirmation:'user',extra:{version:'v2',remaining:['核对附注']}})
    await receipt(run,'received')
    await emit(run,1,'model_state',{sessionId,current:options[1].id,options})
    const held=await api(path+'/messages',{text:'补充输入',refs:[{type:'record',id:handoff.id},{type:'source',id:original.id}]})
    assert.equal(held.status,'waiting')
    const control='/runs/'+task.runId+'/commands'
    const stop=await api(control,{kind:'cancel'})
    assert.equal((await api(path)).commands.find(c=>c.id===stop.commandId).status,'queued')
    assert.equal(packets.some(p=>p.command?.id===stop.commandId),false)
    await emit(run,2,'activity',{sessionId,controlReady:true,text:'原生提示已提交'})
    const cancel=await findCommand(c=>c.id===stop.commandId)
    await emit(run,3,'input_required',{sessionId,requestId:'p1',options:[{id:'accept',label:'允许'}]})
    await api(control,{kind:'answer',nativeRequestId:'p1',choice:'accept'},409)
    await receipt(cancel,'uncertain','取消只有传输回执')
    assert.equal((await api(path)).run.status,'cancelling')
    await api(control,{kind:'resume',commandId:held.commandId},409)
    await api(control,{kind:'edit',text:'编辑后再发',commandId:held.commandId})
    await emit(run,4,'cancelled',{sessionId})
    assert.equal((await api(path)).run.status,'cancelled')
    assert.equal((await api(path)).commands.find(c=>c.id===held.commandId).status,'held')
    assert.equal(packets.filter(p=>p.type==='command'&&p.command.kind==='run').length,1)
    const resumed=await api(control,{kind:'resume',commandId:held.commandId})
    const next=await findCommand(c=>c.id===held.commandId)
    assert.notEqual(task.runId,resumed.runId)
    assert.equal(next.runId,resumed.runId)
    assert.equal(next.payload.inputText,'编辑后再发')
    assert.ok(next.payload.text.startsWith('编辑后再发\n显式引用'))
    assert.deepEqual(next.payload.materials[0].extra,{version:'v2',remaining:['核对附注']})
    assert.equal(next.payload.materials[1].localOnly,true)
    assert.equal(next.payload.materials[1].localPath,undefined)
    assert.equal(next.payload.sessionId,sessionId)
    assert.equal(next.payload.modelId,undefined)
    assert.equal((await api(path)).model.current,options[1].id)
    await emit(next,1,'input_required',{sessionId,requestId:'p2',options:[{id:'accept'}]})
    await receipt(next,'uncertain','原生回执中断')
    const uncertain=await api(path)
    assert.equal(uncertain.run.status,'uncertain')
    assert.equal(uncertain.run.pendingRequest,null)
    await api(path+'/messages',{text:'不会重发运行'},409)
    await emit(next,2,'completed',{sessionId})
    assert.equal((await api(path)).run.status,'completed')
    ws.close();await once(ws,'close')
    const offline=await api(path+'/messages',{text:'离线待发'})
    const preDispatch=await api('/runs/'+offline.runId+'/commands',{kind:'cancel'})
    assert.equal(preDispatch.status,'cancelled')
    assert.equal((await api(path)).commands.find(c=>c.id===offline.commandId).status,'withdrawn')
  } finally {
    if(ws?.readyState===1)ws.close()
    await app.close()
    rmSync(temp,{recursive:true,force:true})
  }
})
