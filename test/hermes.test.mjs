import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {isAbsolute,join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import test from 'node:test'
import {startServer} from '../server/index.ts'
import settings from '../desktop/connector-settings.cjs'

const agent=String.raw`
const {createInterface}=require('node:readline')
const {appendFileSync}=require('node:fs')
const log=(...row)=>appendFileSync(process.env.TEST_ACP_CALLS,JSON.stringify(row)+'\n')
const native='hermes-session'
const cwd=process.cwd()
const available=['custom:first','custom:second'].map(value=>({value,name:value}))
const config=currentValue=>({configOptions:[{id:'model',category:'model',type:'select',currentValue,options:available}]})
const write=frame=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...frame})+'\n')
const update=text=>write({method:'session/update',params:{sessionId:native,
  update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}})
const permission=(id,title)=>write({id,method:'session/request_permission',params:{sessionId:native,
  toolCall:{title},options:[{optionId:'allow_once',name:'Allow once'}]}})
;(async()=>{
  let switchRequest, promptRequest
  log('home',process.env.HERMES_HOME)
  for await(const line of createInterface({input:process.stdin})){
    const {id,method,params,result,error}=JSON.parse(line)
    const reply=value=>write({id,result:value})
    if(method==='initialize')reply({protocolVersion:1,agentInfo:{name:'hermes-agent',version:'fixture'},
      agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},resume:{},fork:{}}}})
    if(method==='session/new'){log('new',params.cwd);reply({sessionId:native,...config('custom:first')})}
    if(method==='session/list'){
      log('list',params.cwd)
      reply({sessions:[{sessionId:'foreign',cwd:cwd+'/unrelated'},
        {sessionId:native,cwd,title:'Hermes session',updatedAt:'2026-11-26T00:00:00Z'}]})
    }
    if(method==='session/load'){
      log('load',params.sessionId,params.cwd)
      update('replayed history')
      permission('external-permission','Existing Hermes permission')
      reply(config('custom:first'))
    }
    if(id==='external-permission')log('external permission',error?.code)
    if(method==='session/resume')log('unexpected resume',params.sessionId)
    if(method==='session/set_config_option'){
      switchRequest={id,value:params.value}
      permission('model-permission','Switch model')
    }
    if(id==='model-permission'){
      log('model permission',result.outcome.outcome)
      if(result.outcome.outcome==='selected')write({id:switchRequest.id,result:config(switchRequest.value)})
      else write({id:switchRequest.id,error:{code:-32603,message:'model_switch_cancelled'}})
    }
    if(method==='session/prompt'){
      const text=params.prompt[0].text.replace(/^工作台通信 [^\n]*\n\n/,'')
      log('prompt',params.sessionId,text)
      if(text==='wait for cancel'){promptRequest=id;continue}
      if(text==='authorize tool'){promptRequest=id;permission('tool-permission','Authorize tool');continue}
      update('Hermes reply')
      reply({stopReason:'end_turn'})
    }
    if(id==='tool-permission'){
      log('tool permission',result.outcome.optionId)
      update('Tool approved')
      write({id:promptRequest,result:{stopReason:'end_turn'}})
    }
    if(method==='session/cancel'){
      log('cancel',params.sessionId)
      write({id:promptRequest,result:{stopReason:'cancelled'}})
    }
  }
})()
`

test('workbench connects Hermes, routes approvals and cancellation, and reloads the scoped native session',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'maoqiu-hermes-test-'))
  const config=join(temp,'node.json'),calls=join(temp,'calls'),home=join(temp,'profile')
  const app=startServer({port:0,dataDir:join(temp,'server'),chat:false})
  let child,exit
  async function stopConnector(){
    if(child?.connected)child.disconnect()
    if(!exit)return
    const stopped=await Promise.race([exit.then(()=>true),delay(2000,false,{ref:false})])
    if(!stopped)child.kill()
    await exit
  }
  try{
    await once(app.server,'listening')
    const address='127.0.0.1:'+app.server.address().port
    writeFileSync(join(temp,'acp'),agent)
    writeFileSync(config,JSON.stringify({url:'ws://'+address+'/api/v1/node',nodeId:'local',stateDir:join(temp,'node'),
      instances:[{id:'hermes',name:'Hermes',adapterKey:'hermes',workspaceRef:temp,command:process.execPath,args:['acp'],
        env:{HERMES_HOME:home,TEST_ACP_CALLS:calls}}]}))
    function startConnector(){
      child=spawn(process.execPath,['connector/index.ts',config],{
        env:{...process.env,NODE_TOKEN:app.auth.cfg.nodes.local},stdio:['ignore','ignore','inherit','ipc'],windowsHide:true})
      exit=once(child,'exit')
    }
    async function request(path,body,expected=200){
      const response=await fetch('http://'+address+'/api/v1'+path,{
        method:body?'POST':'GET',headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'},
        body:body&&JSON.stringify(body)
      })
      const value=await response.json()
      assert.equal(response.status,expected,JSON.stringify(value))
      return value
    }
    async function wait(label,check){
      const end=Date.now()+10000
      while(Date.now()<end){const value=await check();if(value)return value;await delay(40)}
      assert.fail('Timed out: '+label)
    }
    const online=()=>wait('Hermes handshake',async()=>(await request('/instances')).find(i=>i.id==='hermes'&&i.online))
    startConnector()
    const instance=await online()
    assert.equal(instance.capabilities.version,'fixture')
    const sessions='/instances/hermes/sessions'
    const catalog=await request(sessions)
    assert.deepEqual(catalog.items.map(item=>item.id),['hermes-session'])
    const imported=await request(sessions+'/import',{sessionId:'foreign'})
    const rejected=await wait('refusal to import from a different workspace',async()=>{
      const snapshot=await request('/threads/'+imported.thread.id)
      return snapshot.run?.status==='failed'&&snapshot
    })
    assert.equal(rejected.thread.sessionId,null)
    const thread=await request('/threads',{instanceId:'hermes'})
    const path='/threads/'+thread.id
    const snapshot=(runId,status)=>wait(status,async()=>{
      const state=await request(path)
      return state.run?.id===runId&&state.run.status===status&&state
    })
    const ask=(text)=>request(path+'/messages',{text})
    const control=(runId,command)=>request('/runs/'+runId+'/commands',command)
    const answer=(state)=>control(state.run.id,{kind:'answer',nativeRequestId:state.run.pendingRequest.requestId,choice:'allow_once'})

    const prepared=await request(path+'/model',{prepare:true})
    await snapshot(prepared.runId,'completed')
    await request(path+'/model',{modelId:'custom:second'})
    const dismissed=await ask('skip this prompt')
    await snapshot(dismissed.runId,'waiting_input')
    await control(dismissed.runId,{kind:'cancel'})
    await snapshot(dismissed.runId,'cancelled')

    await request(path+'/model',{modelId:'custom:second'})
    const first=await ask('authorize tool')
    const switching=await snapshot(first.runId,'waiting_input')
    assert.equal(switching.run.pendingRequest.text,'Switch model')
    await answer(switching)
    const tool=await wait('tool approval',async()=>{
      const state=await request(path)
      return state.run?.pendingRequest?.text==='Authorize tool'&&state
    })
    await answer(tool)
    const completed=await snapshot(first.runId,'completed')
    assert.equal(completed.thread.sessionId,'hermes-session')
    assert.ok(completed.messages.some(m=>m.text==='Tool approved'))

    await stopConnector()
    await wait('connector offline',async()=>(await request('/instances')).some(i=>i.id==='hermes'&&!i.online))
    startConnector()
    await online()
    const follow=await ask('continue')
    const continued=await snapshot(follow.runId,'completed')
    assert.equal(continued.thread.sessionId,completed.thread.sessionId)
    assert.ok(continued.messages.some(m=>m.text==='Hermes reply'))
    assert.ok(!continued.messages.some(m=>m.text==='replayed history'))

    const last=await ask('wait for cancel')
    await wait('prompt submission',async()=>(await request(path)).messages.some(m=>m.data.runId===last.runId&&m.data.controlReady))
    await control(last.runId,{kind:'cancel'})
    await snapshot(last.runId,'cancelled')

    const wire=readFileSync(calls,'utf8').trim().split('\n').map(line=>JSON.parse(line))
    assert.deepEqual(wire.filter(([op])=>!['list','new','prompt'].includes(op)),[
      ['home',home],['model permission','cancelled'],['model permission','selected'],['tool permission','allow_once'],
      ['home',home],['load','hermes-session',wire.find(([op])=>op==='new')[1]],['external permission',-32601],['cancel','hermes-session']
    ])
    assert.equal(wire.filter(([op])=>op==='new').length,1)
    assert.deepEqual(wire.filter(([op])=>op==='prompt').map(([,id,text])=>[id,text]),[
      ['hermes-session','authorize tool'],['hermes-session','continue'],['hermes-session','wait for cancel']
    ])
  }finally{
    await stopConnector()
    await app.close()
    rmSync(temp,{recursive:true,force:true,maxRetries:4,retryDelay:100})
  }
})

test('desktop stores the Hermes ACP entrypoint and rejects another launcher name',()=>{
  const temp=mkdtempSync(join(tmpdir(),'maoqiu-hermes-settings-'))
  try{
    const file=join(temp,'desktop-connector.json')
    const launcher=join(temp,process.platform==='win32'?'hermes.cmd':'hermes')
    writeFileSync(launcher,'fixture')
    writeFileSync(file,JSON.stringify({stateDir:join(temp,'node'),instances:[]}))
    const config={file,workspace:temp,editable:true}, db={prepare:()=>({get:()=>undefined})}
    const instance={id:'hermes',name:'Hermes',adapterKey:'hermes',profileId:'default',command:launcher,workspaceRef:temp}
    const view=settings.saveInstance(config,db,instance)
    assert.ok(isAbsolute(view.instances[0].workspaceRef))
    assert.equal(view.instances[0].detectedCommand,launcher)
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')).instances[0].args,['acp'])
    assert.throws(()=>settings.saveInstance(config,db,{...instance,command:'node'}),/官方可执行程序/)
  }finally{rmSync(temp,{recursive:true,force:true})}
})
