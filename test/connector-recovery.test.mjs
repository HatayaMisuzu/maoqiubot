import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {startServer} from '../server/index.ts'
import {Store} from '../connector/store.ts'

const fakeAcp=String.raw`
const {createInterface}=require('node:readline')
const {appendFileSync}=require('node:fs')
const {randomUUID}=require('node:crypto')
const log=(...record)=>appendFileSync(process.env.MAOQIU_ACP_TEST_LOG,JSON.stringify(record)+'\n')
const write=(frame)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...frame})+'\n')
let turn
const config=currentValue=>({configOptions:[{id:'model',category:'model',type:'select',currentValue,
  options:['default','manual'].map(value=>({value,name:value}))}]})
log('start')
for await (const line of createInterface({input:process.stdin})) {
  const {id,method,params}=JSON.parse(line)
  const reply=result=>write({id,result})
  if(method==='initialize')reply({protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:true}}})
  if(method==='session/new')reply({sessionId:randomUUID(),...config('default')})
  if(method==='session/resume') {log('resume',params.sessionId);reply({sessionId:params.sessionId,...config('default')})}
  if(method==='session/set_config_option') {
    log('switch',params.sessionId)
    setTimeout(()=>reply(config(params.value)),800)
  }
  if(method==='session/prompt') {
    const text=params.prompt[0].text.replace(/^工作台通信 [^\n]*\n\n/,'')
    log('prompt',params.sessionId,text)
    if(text==='wait-for-cancel') {turn={id,sessionId:params.sessionId};continue}
    write({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'original output'}}}})
    if(text==='disconnect-after-acceptance')setTimeout(()=>process.exit(1),40)
    else reply({stopReason:'end_turn'})
  }
  if(method==='session/cancel') {
    log('cancel',params.sessionId)
    if(turn?.sessionId===params.sessionId) {
      write({id:turn.id,result:{stopReason:'cancelled'}})
      turn=undefined
    }
  }
}
`

test('connector restarts a native DSH process without replaying the interrupted turn',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'maoqiu-native-restart-'))
  const log=join(temp,'native.calls')
  const app=startServer({port:0,dataDir:join(temp,'server'),chat:false})
  let child,exit
  try {
    await once(app.server,'listening')
    const port=app.server.address().port
    const config=join(temp,'node.json')
    writeFileSync(config,JSON.stringify({url:'ws://127.0.0.1:'+port+'/api/v1/node',nodeId:'local',stateDir:join(temp,'node'),
      instances:[{id:'dsh',name:'DSH fixture',adapterKey:'dsh',workspaceRef:temp,env:{MAOQIU_ACP_TEST_LOG:log,DSH_HOME:join(temp,'dsh')},
        command:process.execPath,args:['--input-type=commonjs','-e',`(async()=>{${fakeAcp}})()`]}]}))
    function startConnector(){
      child=spawn(process.execPath,['connector/index.ts',config],{
        env:{...process.env,NODE_TOKEN:app.auth.cfg.nodes.local},
        stdio:['ignore','ignore','inherit','ipc'],windowsHide:true
      })
      exit=once(child,'exit')
    }
    async function disconnectConnector(){
      if(child?.connected)child.disconnect()
      if(!exit)return
      await Promise.race([exit,delay(2000,undefined,{ref:false})])
      if(child.exitCode===null)child.kill()
      await exit
    }
    startConnector()
    async function request(path,body,expected=200){
      const res=await fetch('http://127.0.0.1:'+port+'/api/v1'+path,{
        method:body?'POST':'GET',headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'},
        body:body&&JSON.stringify(body)
      })
      const result=await res.json()
      assert.equal(res.status,expected,JSON.stringify(result))
      return result
    }
    async function wait(label,fn){
      const end=Date.now()+12000
      while(Date.now()<end){const value=await fn();if(value)return value;await delay(50)}
      assert.fail('timed out: '+label)
    }
    async function status(thread,runId,expected){
      return wait(expected,async()=>{
        const s=await request('/threads/'+thread.id)
        return s.run?.id===runId&&s.run.status===expected?s:null
      })
    }
    const online=()=>wait('DSH handshake',async()=>(await request('/instances')).some(i=>i.id==='dsh'&&i.online))
    await online()
    const original=await request('/threads',{instanceId:'dsh'})
    const first=await request('/threads/'+original.id+'/messages',{text:'first-turn'})
    const completed=await status(original,first.runId,'completed')
    const other=await request('/threads',{instanceId:'dsh'})
    const broken=await request('/threads/'+other.id+'/messages',{text:'disconnect-after-acceptance'})
    const uncertain=await status(other,broken.runId,'uncertain')
    assert.ok(uncertain.messages.some(m=>m.text==='original output'))
    assert.notEqual(completed.thread.sessionId,uncertain.thread.sessionId)
    await request('/threads/'+other.id+'/messages',{text:'do not replay'},409)
    await online()
    await request('/threads/'+original.id+'/model',{modelId:'manual'})
    const follow=await request('/threads/'+original.id+'/messages',{text:'wait-for-cancel'})
    await wait('ACP model setup before prompt',()=>readFileSync(log,'utf8').includes('"switch"'))
    await request('/runs/'+follow.runId+'/commands',{kind:'cancel'})
    const cancelled=await status(original,follow.runId,'cancelled')
    assert.ok(cancelled.messages.some(m=>m.data.runId===follow.runId&&m.data.controlReady))
    assert.equal(cancelled.thread.sessionId,completed.thread.sessionId)
    await disconnectConnector()
    await wait('connector offline',async()=>(await request('/instances')).some(i=>i.id==='dsh'&&!i.online))
    const waiting=[await request('/threads',{instanceId:'dsh'}),await request('/threads',{instanceId:'dsh'})]
    const commands=await Promise.all(waiting.map(t=>request('/threads/'+t.id+'/messages',{text:'crash boundary'})))
    const store=new Store(join(temp,'node','connector.sqlite'))
    try {
      for(const [i,c] of commands.entries()){
        store.command({id:c.commandId,threadId:waiting[i].id,runId:c.runId,taskId:null,kind:'run',instanceId:'dsh',payload:{}})
      }
      store.submit(commands[1].commandId)
    } finally {store.db.close()}
    startConnector()
    await online()
    assert.match((await status(waiting[0],commands[0].runId,'failed')).messages.at(-1).text,/尚未发送/)
    await status(waiting[1],commands[1].runId,'uncertain')
    const calls=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line))
    assert.deepEqual(calls,[
      ['start'],['prompt',completed.thread.sessionId,'first-turn'],
      ['prompt',uncertain.thread.sessionId,'disconnect-after-acceptance'],['start'],
      ['resume',completed.thread.sessionId],['switch',completed.thread.sessionId],
      ['prompt',completed.thread.sessionId,'wait-for-cancel'],['cancel',completed.thread.sessionId],
      ['start']
    ])
  } finally {
    if(child?.connected)child.disconnect()
    if(exit)await Promise.race([exit,delay(2000,undefined,{ref:false})])
    if(child?.exitCode===null)child.kill()
    if(exit)await exit
    await app.close()
    rmSync(temp,{recursive:true,force:true,maxRetries:4,retryDelay:100})
  }
})
