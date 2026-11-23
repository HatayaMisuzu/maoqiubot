import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {registry} from './adapters/index.ts'
import {Dsh} from './adapters/dsh.ts'
import type {Instance,Run} from './types.ts'
const [filename,id,...prompts]=process.argv.slice(2)
const config=JSON.parse(readFileSync(filename,'utf8'))
const instance:Instance=config.instances.find((x:Instance)=>x.id===id)
if(!instance) throw new Error('没有该实例')
instance.workspaceRef=resolve(instance.workspaceRef)
const adapter=new registry[instance.adapterKey](instance)
const timer=setTimeout(()=>adapter.close(),120000)
try {
  console.log(JSON.stringify(await adapter.probe()))
  let sessionId:string|undefined
  for(const prompt of prompts) {
    if(prompt==='--new-session'){
      sessionId=undefined
      continue
    }
    if(prompt.startsWith('--resume-session=')){
      sessionId=prompt.slice('--resume-session='.length)
      if(!sessionId)throw Error('需要指定恢复的原生会话 ID')
      continue
    }
    sessionId=await adapter.open(sessionId)
    if(prompt==='--inspect-models'){
      console.log(JSON.stringify({sessionId,...adapter.describeModels?.(sessionId)}))
      continue
    }
    if(prompt.startsWith('--select-model-index=') && adapter instanceof Dsh){
      const option=adapter.describeModels(sessionId).options?.[Number(prompt.split('=')[1])]
      if(!option)throw Error('模型列表序号不存在')
      await adapter.setModel(sessionId,option.id)
      console.log(JSON.stringify({sessionId,...adapter.describeModels(sessionId)}))
      continue
    }
    const run:Run={sessionId,command:{id:randomUUID(),runId:randomUUID(),threadId:'smoke',taskId:null,kind:'run',payload:{text:prompt},instanceId:id},
      emit:(kind,data)=>{
        console.log(JSON.stringify({kind,data}))
        if(kind==='input_required') throw new Error('冒烟测试需要人工许可')
        if(kind==='failed' || kind==='blocked') process.exitCode=1
      }}
    await adapter.run(run,{text:prompt,files:[]})
  }
} finally {clearTimeout(timer);adapter.close()}
