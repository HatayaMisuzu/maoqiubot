import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {Native} from './base.ts'
import type {Input,Run,Adapter} from '../types.ts'
import type {ModelOption,ModelState} from '../../contracts/node.ts'

function inputs(input:Input) {
  return [{type:'text',text:input.text,text_elements:[]},...input.files.map(f=>f.mime.startsWith('image/')
    ? {type:'localImage',path:f.path}
    : {type:'text',text:'用户附件 '+f.name+' ['+f.id+']\n'+f.path,text_elements:[]})]
}
function terminal(turn:any,emit:Run['emit']) {
  const status=turn.status
  if(!['completed','interrupted','failed'].includes(status)) return false
  emit(status==='interrupted'?'cancelled':status,{text:turn.error?.message || '',nativeRunId:turn.id})
  return true
}
export class Codex extends Native implements Adapter {
  models:ModelOption[]=[]
  sessionModels=new Map<string,string>()
  async identity(){
    const {account}=await this.rpc.request('account/read',{refreshToken:false},5000)
    if(account?.type!=='chatgpt')throw Error('请在本机使用官方 Codex 登录 ChatGPT')
    return createHash('sha256').update(String(account.email??'local-chatgpt')).digest('hex')
  }
  endings=new Map<string,{finish:()=>void,fail:(err:Error)=>void}>()
  async probe() {
    const hello=await this.rpc.request('initialize',{clientInfo:{name:'xiaomaoqiu',title:'小毛球工作台',version:'1.0.0'},capabilities:{}})
    this.rpc.send({method:'initialized',params:{}})
    await this.identity()
    try{
      const result=await this.rpc.request('model/list',{limit:100,includeHidden:false},5000)
      this.models=result.data.filter((m:any)=>typeof m.model==='string' && !m.hidden).map((m:any)=>({id:m.model,label:m.displayName||m.model}))
    }catch{this.models=[]}
    // Invalid empty parameters can only validate a method; no session or turn is addressed.
    const supported=async (method:string)=>{
      try {await this.rpc.request(method,{},5000);return true}
      catch(e:any) {return e.code===-32602 || (e.code===-32600 && /missing field.*threadId/.test(e.message))}
    }
    const [steer,cancel,history]=await Promise.all(['turn/steer','turn/interrupt','thread/read'].map(supported))
    return {availableActions:['run','prepare','answer',...(steer?['steer']:[]),...(cancel?['cancel']:[])],version:hello.userAgent,resume:true,history,models:this.models}
  }
  async open(sessionId?:string) {
    if(sessionId && this.sessions.has(sessionId)) return sessionId
    const method=sessionId?'thread/resume':'thread/start'
    const {thread,model}=await this.rpc.request(method,{cwd:this.instance.workspaceRef,...(sessionId?{threadId:sessionId,excludeTurns:true}:{})})
    if(!thread?.id || (sessionId && thread.id!==sessionId) || resolve(thread.cwd)!==resolve(this.instance.workspaceRef))
      throw new Error('原生工作区或线程不符')
    this.sessions.add(thread.id)
    if(typeof model==='string')this.sessionModels.set(thread.id,model)
    return thread.id as string
  }
  describeModels(sessionId:string):ModelState{
    return {current:this.sessionModels.get(sessionId)??null,options:this.models}
  }
  async run(run:Run,input:Input) {
    const model=run.command.payload.modelId
    if(model && !this.models.some(m=>m.id===model))throw Object.assign(Error('Codex 当前账号未提供所选模型'),{code:-32602})
    run.emit('model_state',{sessionId:run.sessionId,...this.describeModels(run.sessionId)})
    this.active.set(run.sessionId,run)
    const end=Promise.withResolvers<void>()
    // A child exit can race turn/start acknowledgement.
    end.promise.catch(()=>{})
    this.endings.set(run.sessionId,{finish:end.resolve,fail:end.reject})
    this.rpc.once('closed',end.reject)
    try {
      const {turn}=await this.rpc.request('turn/start',{threadId:run.sessionId,input:inputs(input),...(model?{model}:{})})
      if(run.nativeRunId && run.nativeRunId!==turn.id) throw new Error('原生回执运行 ID 不一致')
      if(!run.nativeRunId) {run.nativeRunId=turn.id;run.emit('accepted',{sessionId:run.sessionId,nativeRunId:turn.id})}
      if(model){
        this.sessionModels.set(run.sessionId,model)
        run.emit('model_state',{sessionId:run.sessionId,current:model,options:this.models})
      }
      await end.promise
    } finally {
      this.rpc.off('closed',end.reject)
      this.endings.delete(run.sessionId)
      this.finish(run)
    }
  }
  incoming(msg:any) {
    const p=msg.params||{}
    const run=this.active.get(p.threadId)
    if(!run || (p.turnId && run.nativeRunId && run.nativeRunId!==p.turnId)) {
      if(msg.id!=null) this.rpc.send({id:msg.id,error:{code:-32601,message:'Unbound request'}})
      return
    }
    if(msg.method==='turn/started' && !run.nativeRunId) {
      run.nativeRunId=p.turn.id
      run.emit('accepted',{sessionId:run.sessionId,nativeRunId:p.turn.id})
    } else if(msg.method==='turn/completed' && (!run.nativeRunId || run.nativeRunId===p.turn.id)) {
      if(terminal(p.turn,run.emit)) this.endings.get(run.sessionId)?.finish()
    } else if(msg.method==='model/rerouted' && typeof p.toModel==='string') {
      run.emit('activity',{text:'本轮原生路由使用 '+p.toModel,fromModel:p.fromModel,toModel:p.toModel,reason:p.reason})
    } else if(msg.method==='item/completed' || msg.method==='item/started') {
      const i=p.item
      if(i.type==='agentMessage' && msg.method==='item/completed')
        run.emit('message',{text:i.text,itemId:i.id})
      else if(['commandExecution','fileChange','mcpToolCall','webSearch','dynamicToolCall','imageGeneration'].includes(i.type)){
        const detail=i.command||i.tool||i.query||i.type
        run.emit('activity',{text:String(detail),itemId:i.id,stage:msg.method,status:i.status})
        if(i.type==='fileChange' && msg.method==='item/completed' && i.status==='completed')
          for(const change of i.changes??[]) run.emit('artifact',{text:change.path,path:change.path,scope:'local',itemId:i.id})
      }
    } else if(msg.id!=null) {
      if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(msg.method)) {
        const offered=p.availableDecisions??['accept','decline']
        const options=offered.filter((x:any)=>['accept','decline','cancel'].includes(x)).map((id:string)=>({id,label:id}))
        if(options.length) this.ask(run,p.reason||p.command||'原生操作请求授权',options,choice=>this.rpc.write({id:msg.id,result:{decision:choice}}))
        else this.rpc.send({id:msg.id,result:{decision:'decline'}})
      } else this.rpc.send({id:msg.id,error:{code:-32601,message:'Unsupported native request '+msg.method}})
    }
  }
  async steer(run:Run,input:Input) {
    if(!run.nativeRunId) throw new Error('尚未收到原生运行回执')
    await this.rpc.request('turn/steer',{threadId:run.sessionId,expectedTurnId:run.nativeRunId,input:inputs(input)})
  }
  async cancel(run:Run) {
    if(!run.nativeRunId) throw new Error('尚未收到原生运行回执')
    await this.rpc.request('turn/interrupt',{threadId:run.sessionId,turnId:run.nativeRunId})
  }
  async inspect(run:Run) {
    if(!run.nativeRunId) return false
    const {thread}=await this.rpc.request('thread/read',{threadId:run.sessionId,includeTurns:true})
    if(thread?.id!==run.sessionId || resolve(thread.cwd)!==resolve(this.instance.workspaceRef)) return false
    const turn=thread.turns?.find((x:any)=>x.id===run.nativeRunId)
    if(!turn || !['completed','interrupted','failed'].includes(turn.status)) return false
    for(const item of turn.items??[]) if(item.type==='agentMessage') run.emit('message',{itemId:item.id,text:item.text})
    return terminal(turn,run.emit)
  }
}
