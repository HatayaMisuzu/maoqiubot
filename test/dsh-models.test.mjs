import assert from 'node:assert/strict'
import test from 'node:test'
import {Dsh} from '../connector/adapters/dsh.ts'

const fakeAcp=String.raw`
const {createInterface}=require('node:readline')
const sessionId='native-a'
const available=[{value:'first',name:'First'},{value:'second',name:'Second'}]
const config=currentValue=>({configOptions:[{id:'pick-model',category:'model',type:'select',currentValue,options:available}]})
const update=current=>({method:'session/update',params:{sessionId,update:{sessionUpdate:'config_option_update',...config(current)}}})
const write=(...frames)=>process.stdout.write(frames.map(frame=>JSON.stringify({jsonrpc:'2.0',...frame})).join('\n')+'\n')
for await (const line of createInterface({input:process.stdin})) {
  const {id,method,params}=JSON.parse(line)
  const reply=result=>({id,result})
  if(method==='initialize')write(reply({protocolVersion:1}))
  if(method==='session/new')write(update('first'),reply({sessionId}))
  if(method==='session/set_config_option')write(reply(config(params.value)),update('first'))
  if(method==='session/prompt')write(reply({stopReason:'end_turn'}))
}
`

test('DSH reads setup notifications and stops when the session changes model before prompt',async t=>{
  const adapter=new Dsh({id:'fixture',name:'DSH fixture',adapterKey:'dsh',workspaceRef:process.cwd(),command:process.execPath,
    args:['--input-type=commonjs','-e',`(async()=>{${fakeAcp}})()`]})
  t.after(()=>adapter.close())
  await adapter.probe()
  const sessionId=await adapter.open()
  assert.equal(adapter.describeModels(sessionId).current,'first')

  const command={id:'command',runId:'run',threadId:'thread',taskId:null,kind:'run',instanceId:'fixture',payload:{modelId:'second'}}
  const models=[]
  const run={sessionId,command,emit:(kind,data)=>{if(kind==='model_state')models.push(data.current)}}
  await assert.rejects(adapter.run(run,{text:'fixture',files:[]}),{code:-32602,message:/未开始运行/})
  assert.equal(models.at(-1),'first')
})
