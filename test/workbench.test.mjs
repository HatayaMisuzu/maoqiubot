import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import {startServer} from '../server/index.ts'
import {transfer} from '../scripts/backup.ts'
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function waitFor(fn){for(let i=0;i<150;i++){const v=await fn();if(v)return v;await sleep(15)}throw Error('condition timed out')}
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
    await emit(prepare,1,'model_state',{sessionId,current:options[0].id,options})
    await emit(prepare,2,'completed',{sessionId})
    const preflight=await api(path)
    assert.equal(preflight.thread.sessionId,sessionId)
    assert.equal(preflight.model.previewError,null)
    assert.equal(preflight.run.modelSetup,1)
    await api(path+'/model',{modelId:options[1].id})
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
