import assert from 'node:assert/strict'
import test from 'node:test'
import {Codex} from '../connector/adapters/codex.ts'

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
