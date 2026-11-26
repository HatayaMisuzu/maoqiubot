import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { startServer } from '../server/index.ts'

test('主聊工具软预算按需增加并在配置的硬上限停止',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'maoqiu-budget-'))
  const contexts=[]
  let tools=0
  const provider={name:'budget fixture',async generate(prompt){
    const context=JSON.parse(prompt.slice(prompt.indexOf('\n')+1))
    contexts.push(context)
    if(tools<14)return {action:'tool',tool:'utility_calculate',arguments:JSON.stringify({expression:'1+'+(++tools)})}
    return {action:'reply',text:'已停止'}
  }}
  const app=startServer({port:0,dataDir:dir,chat:true,chatProvider:provider})
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true})})
  await once(app.server,'listening')
  const base='http://127.0.0.1:'+app.server.address().port+'/api/v1'
  const api=async(path,body)=>{
    const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'},body:body&&JSON.stringify(body)})
    const data=await response.json()
    assert.equal(response.status,200,data.error)
    return data
  }
  await api('/chat/policy',{toolBudget:5,toolHardLimit:12})
  const thread=await api('/threads',{title:'预算测试'})
  const {messageId}=await api('/threads/'+thread.id+'/messages',{text:'执行一组计算并报告结果'})
  for(let attempt=0;attempt<200;attempt++){
    const snapshot=await api('/threads/'+thread.id)
    if(snapshot.mainChat.pending.some(job=>job.messageId===messageId&&job.status==='budget_paused'))break
    await sleep(15)
  }
  let snapshot=await api('/threads/'+thread.id)
  assert.equal(snapshot.mainChat.pending.find(job=>job.messageId===messageId)?.status,'budget_paused')
  assert.equal(snapshot.mainChat.pending.find(job=>job.messageId===messageId)?.budget.used,12)
  await api('/chat/policy',{toolHardLimit:20})
  const resumed=await api('/chat/continue',{messageId,hardLimit:20})
  assert.equal(resumed.status,'queued')
  for(let attempt=0;attempt<200;attempt++){
    snapshot=await api('/threads/'+thread.id)
    if(snapshot.messages.some(message=>message.data?.replyTo===messageId&&message.role==='assistant'))break
    await sleep(15)
  }
  assert.equal(snapshot.messages.filter(message=>message.kind==='tool'&&message.data?.ok===true&&message.data?.replyTo===messageId).length,13)
  assert.equal(snapshot.mainChat.pending.some(job=>job.messageId===messageId),false)
  assert.ok(contexts.some(context=>context.toolBudget?.softLimit===5))
  assert.ok(contexts.some(context=>context.toolBudget?.softLimit===12))
  assert.ok(contexts.some(context=>context.toolBudget?.used===12))
  const preferences=await api('/threads/'+thread.id+'/budget',{toolBudget:{softLimit:4,hardLimit:6}})
  assert.deepEqual(preferences.toolBudget,{softLimit:4,hardLimit:6})
  const next=await api('/threads/'+thread.id+'/messages',{text:'单轮覆盖',toolBudget:{softLimit:2,hardLimit:3}})
  for(let attempt=0;attempt<200&&!contexts.some(context=>context.currentEvent?.id===next.messageId);attempt++)await sleep(15)
  assert.deepEqual(contexts.find(context=>context.currentEvent?.id===next.messageId)?.toolBudget,{used:0,softLimit:2,hardLimit:3})
  assert.deepEqual((await api('/threads/'+thread.id+'/budget')).toolBudget,{softLimit:4,hardLimit:6})
})

test('重启后从已写入的工具回执恢复同一轮，不重复执行已完成操作',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'maoqiu-budget-recovery-'))
  let app
  t.after(async()=>{if(app)await app.close();rmSync(dir,{recursive:true,force:true})})
  let firstStarted
  const started=new Promise(resolve=>{firstStarted=resolve})
  let secondStarted
  const secondWaiting=new Promise(resolve=>{secondStarted=resolve})
  const firstProvider={name:'recovery fixture',async generate(prompt,_attachments,options){
    const context=JSON.parse(prompt.slice(prompt.indexOf('\n')+1))
    if(!context.toolResults?.length)return {action:'tool',tool:'utility_calculate',arguments:'{"expression":"20+22"}'}
    secondStarted()
    return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('simulated stop')),{once:true}))
  }}
  app=startServer({port:0,dataDir:dir,chat:true,chatProvider:firstProvider})
  await once(app.server,'listening')
  let base='http://127.0.0.1:'+app.server.address().port+'/api/v1'
  const api=async(path,body)=>{
    const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'},body:body&&JSON.stringify(body)})
    const data=await response.json()
    assert.equal(response.status,200,data.error)
    return data
  }
  const thread=await api('/threads',{title:'恢复预算任务'})
  const {messageId}=await api('/threads/'+thread.id+'/messages',{text:'执行这项计算并核对结果'})
  await secondWaiting
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='tool' AND json_extract(data,'$.replyTo')=? AND json_extract(data,'$.ok')=1").get(messageId).n,1)
  await app.close()
  app=null
  const recovered=[]
  const resumedProvider={name:'resumed fixture',async generate(prompt){
    recovered.push(JSON.parse(prompt.slice(prompt.indexOf('\n')+1)))
    return {action:'reply',text:'恢复后已完成'}
  }}
  app=startServer({port:0,dataDir:dir,chat:true,chatProvider:resumedProvider})
  await once(app.server,'listening')
  base='http://127.0.0.1:'+app.server.address().port+'/api/v1'
  for(let attempt=0;attempt<200;attempt++){
    const snapshot=await api('/threads/'+thread.id)
    if(snapshot.messages.some(message=>message.data?.replyTo===messageId&&message.role==='assistant'))break
    await sleep(15)
  }
  const snapshot=await api('/threads/'+thread.id)
  assert.equal(snapshot.messages.filter(message=>message.kind==='tool'&&message.data?.replyTo===messageId&&message.data?.ok===true).length,1)
  assert.equal(snapshot.messages.find(message=>message.data?.replyTo===messageId&&message.role==='assistant')?.text,'恢复后已完成')
  assert.ok(recovered[0].toolResults.some(result=>result.result?.value==='42'))
})

test('重启后不会重放没有持久回执的异步副作用',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'maoqiu-budget-uncertain-'))
  let app,sideEffects=0
  t.after(async()=>{if(app)await app.close();rmSync(dir,{recursive:true,force:true})})
  let effectStarted
  const started=new Promise(resolve=>{effectStarted=resolve})
  const provider={name:'uncertain fixture',async generate(){
    return {action:'tool',tool:'bot_desktop_reconnect',arguments:'{}'}
  }}
  const desktop={status(){return {}},save(){return {}},openPath:async()=>'',notify(){},restart(){
    sideEffects++
    effectStarted()
    return new Promise(()=>{})
  }}
  app=startServer({port:0,dataDir:dir,chat:true,chatProvider:provider,desktop})
  await once(app.server,'listening')
  let base='http://127.0.0.1:'+app.server.address().port+'/api/v1'
  const api=async(path,body)=>{
    const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'},body:body&&JSON.stringify(body)})
    const data=await response.json()
    assert.equal(response.status,200,data.error)
    return data
  }
  await api('/chat/policy',{desktop:true})
  const thread=await api('/threads',{title:'核对异步副作用'})
  const {messageId}=await api('/threads/'+thread.id+'/messages',{text:'请重连桌面连接器'})
  let proposal
  for(let attempt=0;attempt<200;attempt++){
    const snapshot=await api('/threads/'+thread.id)
    proposal=snapshot.mainChat.pending.find(job=>job.messageId===messageId)?.proposal
    if(proposal)break
    await sleep(15)
  }
  assert.ok(proposal)
  await api('/chat/approve',{messageId,approvalId:proposal.id,approved:true})
  await started
  await app.close()
  app=null
  app=startServer({port:0,dataDir:dir,chat:true,chatProvider:provider,desktop})
  await once(app.server,'listening')
  base='http://127.0.0.1:'+app.server.address().port+'/api/v1'
  for(let attempt=0;attempt<200;attempt++){
    const snapshot=await api('/threads/'+thread.id)
    if(snapshot.mainChat.pending.every(job=>job.status!=='working'))break
    await sleep(15)
  }
  const recovered=await api('/threads/'+thread.id)
  assert.equal(recovered.mainChat.pending.some(job=>job.messageId===messageId),false)
  assert.equal(sideEffects,1)
  assert.ok(recovered.messages.some(message=>message.kind==='error'&&message.data?.uncertain===true))
})
