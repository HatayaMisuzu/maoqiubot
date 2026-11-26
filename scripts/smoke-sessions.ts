// Uses the signed-in local Codex and a fresh workspace. Every prompt asks for a text-only reply.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startServer } from '../server/index.ts'

const temp=mkdtempSync(join(tmpdir(),'maoqiu-session-smoke-'))
const workspace=join(temp,'workspace')
mkdirSync(workspace)
const start=()=>startServer({dataDir:join(temp,'server'),port:0,chat:false})
let app=start()
await once(app.server,'listening')
const serverUrl=()=>'http://127.0.0.1:'+(app.server.address() as {port:number}).port+'/api/v1'
let base=serverUrl()
const config=join(temp,'connector.json')
function startConnector(){
  writeFileSync(config,JSON.stringify({url:base.replace('http:','ws:')+'/node',nodeId:'local',stateDir:join(temp,'node'),
  instances:[{id:'smoke',name:'Codex',adapterKey:'codex',command:'codex',args:['app-server'],workspaceRef:workspace}]}))
  return spawn(process.execPath,['connector/index.ts',config],{env:{...process.env,NODE_TOKEN:app.auth.cfg.nodes.local},
  windowsHide:true,stdio:['ignore','ignore','inherit','ipc']})
}
let child=startConnector(),closed=once(child,'exit')
async function stopConnector(){
  if(child.connected)child.disconnect()
  await Promise.race([closed,delay(4000)])
  if(child.exitCode===null&&child.signalCode===null){
    child.kill()
    await Promise.race([closed,delay(2000)])
  }
}
async function api(path:string,body?:any){
  const res=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'},
    body:body?JSON.stringify({...body,requestId:crypto.randomUUID()}):undefined})
  const data:any=await res.json()
  if(!res.ok)throw Error(String(data.error))
  return data
}
async function until(fn:()=>any,label:string,timeout=90000){
  const end=Date.now()+timeout
  do{const result=await fn();if(result)return result;await delay(300)}while(Date.now()<end)
  throw Error(label+' 超时')
}
function complete(runId:string){
  return until(()=>{
    const run=app.db.prepare('SELECT status FROM runs WHERE id=?').get(runId)
    if(run&&['uncertain','failed','cancelled','blocked','waiting_input'].includes(String(run.status))){
      const receipt=app.db.prepare('SELECT detail FROM commands WHERE runId=? AND detail IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(runId)
      throw Error('运行 '+run.status+(receipt?' '+String(receipt.detail).slice(0,180):''))
    }
    return run?.status==='completed'
  },'原生回执')
}
try{
  await until(async()=>(await api('/instances')).find((i:any)=>i.id==='smoke'&&i.online),'握手',20000)
  const project=await api('/projects',{name:'临时会话验收'})
  await api('/projects/'+project.id+'/workspaces',{instanceId:'smoke',workspaceRef:workspace})
  const origin=await api('/threads',{projectId:project.id})
  const goal=(marker:string)=>'只回复 '+marker+'。请勿使用工具、读写文件或提交报告。'
  const direct=await api('/threads',{instanceId:'smoke',projectId:project.id,firstMessage:{text:goal('A_OK')}})
  await complete(direct.receipt.runId)
  const b=await api('/tasks',{originThreadId:origin.id,projectId:project.id,instanceId:'smoke',goal:goal('B_OK')})
  await complete(b.runId)
  const c=await api('/tasks',{originThreadId:origin.id,projectId:project.id,instanceId:'smoke',goal:goal('C_OK')})
  await complete(c.runId)
  const thread=(id:string)=>api('/threads/'+id).then(data=>data.thread)
  const ids=await Promise.all([direct.thread.id,b.workThreadId,c.workThreadId].map(async id=>(await thread(id)).sessionId))
  assert.equal(new Set(ids).size,3)
  assert.ok(ids.every(Boolean))
  console.log('PASS 三个工作台话题绑定三个不同原生会话')
  const baseThread='/threads/'+b.workThreadId
  const follow=await api(baseThread+'/messages',{text:'请重复上一轮英文代号，再加上 FOLLOW_OK。请勿使用工具。'})
  await complete(follow.runId)
  assert.equal((await thread(b.workThreadId)).sessionId,ids[1])
  const page=await api(baseThread+'/native')
  assert.ok(page.items.some((i:any)=>i.role==='assistant'&&i.text.includes('B_OK')&&i.text.includes('FOLLOW_OK')))
  console.log('PASS 继续同一 B，按原生历史读取新回帖')
  await stopConnector()
  await app.close()
  app=start()
  await once(app.server,'listening')
  base=serverUrl()
  child=startConnector()
  closed=once(child,'exit')
  await until(async()=>(await api('/instances')).find((i:any)=>i.id==='smoke'&&i.online),'重启握手',20000)
  const side=await api('/threads',{projectId:project.id,title:'另一个讨论'})
  const review=await api('/tasks',{originThreadId:side.id,projectId:project.id,instanceId:'smoke',taskId:b.taskId,
    goal:'只写上次回复中的两个英文代号，并加上 REVIEW_OK。请勿使用工具。'})
  await complete(review.runId)
  assert.equal(review.workThreadId,b.workThreadId)
  assert.equal((await thread(review.workThreadId)).sessionId,ids[1])
  assert.ok((await api(baseThread+'/native')).items.some((item:any)=>item.role==='assistant'&&['B_OK','FOLLOW_OK','REVIEW_OK'].every(token=>item.text.includes(token))))
  console.log('PASS 服务和连接器重启后，从其他侧聊继续原任务，原生回复记得用户接管后的内容')
  const branch=await api(baseThread+'/lifecycle',{action:'fork',title:'独立验证'})
  await complete(branch.runId)
  assert.ok((await thread(branch.id)).sessionId!==ids[1])
  const archive=await api(baseThread+'/lifecycle',{action:'archive'})
  await complete(archive.runId)
  assert.equal((await thread(b.workThreadId)).state,'archived')
  const restored=await api(baseThread+'/lifecycle',{action:'restore'})
  await complete(restored.runId)
  assert.equal((await thread(b.workThreadId)).sessionId,ids[1])
  assert.equal((await thread(b.workThreadId)).state,'active')
  console.log('PASS 分支、原生归档和恢复均收到实际回执')
}finally{
  await stopConnector()
  app.server.closeAllConnections()
  await app.close()
  await rm(temp,{recursive:true,force:true,maxRetries:4,retryDelay:250}).catch(()=>console.warn('临时验收目录仍被占用'))
}
