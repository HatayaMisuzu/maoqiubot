import assert from 'node:assert/strict'
import test from 'node:test'
import {Codex} from '../connector/adapters/codex.ts'
import {agentEnvironment} from '../connector/rpc.ts'

const fakeAppServer=String.raw`(async()=>{
  const {createInterface}=require('node:readline')
  const mode=process.env.MAOQIU_CODEX_TEST_MODE
  const write=frame=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...frame})+'\n')
  for await(const line of createInterface({input:process.stdin})){
    const request=JSON.parse(line)
    if(request.method==='fixture/ready'){
      write({id:request.id,result:{ready:true}})
      continue
    }
    if(request.method==='config/read'){
      write({id:request.id,result:{config:{model:'fixture-model',model_provider:'local-gateway',
        model_providers:{'local-gateway':{base_url:'https://'+mode+'.example/v1',env_key:'MAOQIU_CODEX_FIXTURE_KEY'}}}}})
      continue
    }
    if(request.method==='account/read'){
      write({id:request.id,result:{account:null,requiresOpenaiAuth:false}})
      continue
    }
    if(request.method!=='turn/start')continue
    const threadId=request.params.threadId
    const turn={id:'turn-fixture',status:'completed'}
    if(mode==='completed-before-ack'){
      write({method:'turn/completed',params:{threadId,turn}})
      setTimeout(()=>{
        write({id:request.id,result:{turn}})
        write({method:'fixture/ackSent',params:{}})
      },700)
    }else if(mode==='started-then-timeout'){
      setTimeout(()=>write({method:'turn/started',params:{threadId,turn:{id:turn.id}}}),5)
      setTimeout(()=>write({method:'turn/completed',params:{threadId,turn}}),500)
    }else if(mode==='usage'){
      const update=(turnId,input,output,lastInput,lastOutput)=>write({method:'thread/tokenUsage/updated',params:{threadId,turnId,
        tokenUsage:{total:{inputTokens:input,outputTokens:output,totalTokens:input+output},
          last:{inputTokens:lastInput,outputTokens:lastOutput,totalTokens:lastInput+lastOutput}}}})
      write({method:'turn/started',params:{threadId,turn}})
      update('previous-turn',900,100,900,100)
      update(turn.id,905,103,5,3)
      update(turn.id,905,103,5,3)
      update(turn.id,912,107,7,4)
      write({id:request.id,result:{turn}})
      write({method:'turn/completed',params:{threadId,turn}})
    }
  }
})()`

async function start(mode){
  const adapter=new Codex({id:'codex-fixture',name:'Codex fixture',adapterKey:'dsh',workspaceRef:process.cwd(),
    command:process.execPath,args:['-e',fakeAppServer],env:{MAOQIU_CODEX_TEST_MODE:mode}})
  adapter.turnStartTimeoutMs=300
  await adapter.rpc.request('fixture/ready',{},10000)
  const events=[]
  const command={id:'command-'+mode,runId:'run-'+mode,threadId:'thread-'+mode,taskId:null,kind:'run',instanceId:'codex-fixture',payload:{}}
  const run={command,sessionId:'session-'+mode,nativeRunId:null,emit:(kind,data)=>events.push({kind,data})}
  const ackSent=new Promise(resolve=>{
    const onIncoming=msg=>{
      if(msg.method==='fixture/ackSent'){
        adapter.rpc.off('incoming',onIncoming)
        resolve()
      }
    }
    adapter.rpc.on('incoming',onIncoming)
  })
  return {adapter,run,events,ackSent}
}

test('Codex retains a completed turn that arrives before turn/start acknowledgement',async t=>{
  const {adapter,run,events,ackSent}=await start('completed-before-ack')
  t.after(()=>adapter.close())
  await adapter.run(run,{text:'fixture',files:[]})
  assert.deepEqual(events.filter(event=>['accepted','completed'].includes(event.kind)).map(event=>event.kind),['accepted','completed'])
  assert.equal(run.nativeRunId,'turn-fixture')
  await ackSent
  assert.equal(adapter.rpc.pending.size,0)
  assert.equal(adapter.active.has(run.sessionId),false)
})

test('Codex keeps a turn active after start acknowledgement timeout when its native ID is known',async t=>{
  const {adapter,run,events}=await start('started-then-timeout')
  t.after(()=>adapter.close())
  await adapter.run(run,{text:'fixture',files:[]})
  assert.deepEqual(events.filter(event=>['accepted','completed'].includes(event.kind)).map(event=>event.kind),['accepted','completed'])
  assert.equal(run.nativeRunId,'turn-fixture')
  assert.equal(adapter.active.has(run.sessionId),false)
})

test('Codex leaves an unidentified start timeout without a success result',async t=>{
  const {adapter,run,events}=await start('unidentified-timeout')
  t.after(()=>adapter.close())
  await assert.rejects(adapter.run(run,{text:'fixture',files:[]}),/turn\/start 等待原生响应超时/)
  assert.equal(run.nativeRunId,null)
  assert.equal(events.some(event=>event.kind==='completed'),false)
  assert.equal(adapter.active.has(run.sessionId),false)
})

test('Codex sums only the current turn’s usage across native requests',async t=>{
  const {adapter,run,events}=await start('usage')
  t.after(()=>adapter.close())
  adapter.sessionModels.set(run.sessionId,'fixture-model')
  await adapter.run(run,{text:'fixture',files:[]})
  assert.deepEqual(events.find(event=>event.kind==='completed').data.usage,
    {model:'fixture-model',inputTokens:12,outputTokens:7,totalTokens:19})
})

test('Codex native identity changes when the same provider ID points to another endpoint or key',async t=>{
  const first=await start('first')
  t.after(()=>first.adapter.close())
  const second=await start('second')
  t.after(()=>second.adapter.close())
  await assert.rejects(first.adapter.identity(),/官方 Codex/)
  for(const {adapter} of [first,second])adapter.instance.codexProviderMode='native'
  const initial=await first.adapter.identity()
  assert.notEqual(initial,await second.adapter.identity())
  first.adapter.instance.env.MAOQIU_CODEX_FIXTURE_KEY='rotated-fixture-key'
  assert.notEqual(initial,await first.adapter.identity())
  const env={OPENAI_API_KEY:'provider-fixture-key',OWNER_TOKEN:'owner-fixture-token'}
  assert.equal(agentEnvironment({adapterKey:'codex',env}).OPENAI_API_KEY,undefined)
  const nativeEnv=agentEnvironment({adapterKey:'codex',codexProviderMode:'native',env})
  assert.equal(nativeEnv.OPENAI_API_KEY,env.OPENAI_API_KEY)
  assert.equal(nativeEnv.OWNER_TOKEN,undefined)
})
