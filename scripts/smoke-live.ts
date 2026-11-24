import { startServer } from '../server/index.ts'
import { once } from 'node:events'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { Codex } from '../connector/adapters/codex.ts'

const temp=mkdtempSync(join(tmpdir(),'maoqiu-live-')), workspace=join(temp,'workspace')
mkdirSync(workspace)
const app=startServer({port:0,dataDir:join(temp,'server')})
await once(app.server,'listening')
const url='http://127.0.0.1:'+(app.server.address() as any).port
const config=JSON.parse(readFileSync(new URL('../connector/config.example.json',import.meta.url),'utf8'))
config.url=url.replace('http:','ws:')+'/api/v1/node'
config.stateDir=join(temp,'node')
config.instances=config.instances.filter((i:any)=>i.adapterKey==='codex').map((i:any)=>({...i,workspaceRef:workspace}))
const file=join(temp,'node.json')
writeFileSync(file,JSON.stringify(config))
const child=spawn(process.execPath,['connector/index.ts',file],{env:{...process.env,NODE_TOKEN:app.auth.cfg.nodes.local},stdio:['ignore','inherit','inherit','ipc'],windowsHide:true})
const exit=once(child,'exit')
const closed=once(child,'close')
async function api(path:string,body?:any){
  const res=await fetch(url+'/api/v1'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'},body:body?JSON.stringify({...body,requestId:crypto.randomUUID()}):undefined})
  const data:any=await res.json()
  if(!res.ok)throw Error(data.error)
  return data
}
async function wait<T>(label:string,fn:()=>Promise<T>){
  const end=Date.now()+200000
  while(Date.now()<end){const result=await fn();if(result)return result;await sleep(500)}
  throw Error('等待超时 '+label)
}
try{
  await wait('连接节点',async()=>{
    const native=(await api('/instances')).find((i:any)=>i.id==='codex-local')
    if(native&&!native.online&&native.capabilities?.error)throw Error('节点启动失败 '+native.capabilities.error)
    return native?.online
  })
  console.log('本机 Codex 连接器已握手')
  const p=await api('/projects',{name:'一次性验收项目'})
  const inst=(await api('/instances')).find((i:any)=>i.id==='codex-local')
  await api('/projects/'+p.id+'/workspaces',{instanceId:inst.id,workspaceRef:inst.workspaceRef})
  const t=await api('/threads',{projectId:p.id,title:'主聊验收'})
  await api('/threads/'+t.id+'/messages',{text:'请实际派活，明确委派给 codex-local。在工作话题只回复 MAOQIU_WORKER_OK，无需调用任何工具，不读写文件。'})
  const card=await wait('主聊真实委派',async()=>{
    const s=await api('/threads/'+t.id)
    const card=s.messages.find((m:any)=>m.kind==='task_card')
    if(card)return card
    const err=s.messages.find((m:any)=>m.kind==='error'||m.role==='assistant'&&m.kind==='message')
    if(err)throw Error('主聊没有产生委派：'+err.text)
    return null
  })
  const task=(await api('/tasks/'+card.taskId)).task, path='/threads/'+task.workThreadId
  console.log('主聊已生成任务卡，等待 Codex 原生回帖')
  async function waitEnd(previous?:string){
    return wait('原生终态',async()=>{
      const s=await api(path),r=s.run
      if(r && r.id!==previous && ['failed','blocked','uncertain','waiting_input'].includes(r.status))throw Error('原生状态 '+r.status+' '+String(s.messages.at(-1)?.text??'').slice(0,300))
      return r && r.id!==previous && r.status==='completed'?s:null
    })
  }
  const first=await waitEnd()
  assert.ok(first.messages.some((m:any)=>m.role==='assistant'&&m.kind==='message'&&m.text.includes('MAOQIU_WORKER_OK')))
  console.log('已验证主聊真实委派、Codex 原生回帖和终态')
  await api(path+'/messages',{text:'保持同一线程，不调用工具。请把上一轮的英文标记原样写出，再写 MAOQIU_FOLLOWUP_OK。'})
  const second=await waitEnd(first.run.id)
  assert.equal(second.thread.sessionId,first.thread.sessionId)
  assert.notEqual(second.run.nativeRunId,first.run.nativeRunId)
  assert.ok(second.messages.some((m:any)=>m.role==='assistant'&&m.kind==='message'&&m.text.includes('MAOQIU_FOLLOWUP_OK')&&m.text.includes('MAOQIU_WORKER_OK')))
  for(let i=0;i<3;i++)await api('/tasks/'+card.taskId)
  const follow=await api('/threads',{projectId:p.id,title:'在新话题查询旧任务'})
  await api('/threads/'+follow.id+'/messages',{text:'请只读查询刚才派给 codex-local 的任务当前进度，在这个新话题回报已有结果。'})
  const update=await wait('新话题查询旧任务',async()=>{
    const s=await api('/threads/'+follow.id)
    const error=s.messages.find((m:any)=>m.kind==='error'||m.kind==='task_card')
    if(error)throw Error('主聊未返回已有任务状态：'+error.text)
    const update=s.messages.find((m:any)=>m.kind==='task_update')
    if(update)return update
    const lookup=s.messages.find((m:any)=>m.kind==='tool'&&m.data.tool==='task_progress'&&m.data.ok&&m.data.resultId===card.taskId)
    const reply=s.messages.find((m:any)=>m.role==='assistant'&&m.kind==='message')
    if(reply&&!lookup)throw Error('主聊没有查询实际任务：'+reply.text)
    return lookup&&reply?{...reply,taskId:lookup.data.resultId}:null
  })
  assert.equal(update.taskId,card.taskId)
  assert.ok(update.text.includes('MAOQIU_FOLLOWUP_OK'))
  assert.equal(app.db.prepare('SELECT count(*) n FROM runs').get()?.n,2)
  const timeline=await api('/projects/'+p.id+'/timeline')
  assert.ok(timeline.items.find((r:any)=>r.body.includes('MAOQIU_FOLLOWUP_OK')))
  console.log('已验证同一原生线程的两个 turn、三次只读查看、新话题查询旧任务和项目结果')
  const registered=(await api('/instances')).find((i:any)=>i.id==='codex-local')
  if(!registered.capabilities.sessionList)throw Error('本机 Codex 未声明可核对的会话目录')
  const existing=await wait('读取本次原生会话',async()=>{
    const catalog=await api('/instances/codex-local/sessions?projectId='+p.id)
    return catalog.items.find((item:any)=>item.id===second.thread.sessionId)
  })
  const duplicate=await api('/instances/codex-local/sessions',{projectId:p.id,sessionId:existing.id})
  assert.equal(duplicate.thread.id,second.thread.id)
  child.disconnect()
  await Promise.race([exit,sleep(4000)])
  assert.notEqual(child.exitCode,null,'原导入前须释放该线程的写入客户端')
  const independent=new Codex(config.instances[0])
  const nativeClosed=once(independent.rpc.process,'close')
  try{
    assert.equal((await independent.probe()).sessionList,true)
    assert.equal(await independent.importSession(existing.id),existing.id)
  }finally{
    independent.close()
    await Promise.race([nativeClosed,sleep(2500)]).catch(()=>{})
  }
  console.log('已验证官方 Codex 会话目录、独立原生进程核对并接续会话、工作台重复导入指向原话题')
}finally{
  if(child.connected)child.disconnect()
  await Promise.race([closed,sleep(2500)])
  if(child.exitCode===null)child.kill()
  await app.close()
  try{await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
  catch(e){console.warn('临时验收目录仍被原生进程占用',temp,(e as Error).message)}
}
