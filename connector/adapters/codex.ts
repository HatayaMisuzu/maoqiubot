import {relative,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {Native} from './base.ts'
import type {Input,Run,Adapter} from '../types.ts'
import type {ModelOption,ModelState,NativeAction,NativeHistory,UsageWindow} from '../../contracts/node.ts'

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
    const {account}=await this.rpc.request('account/read',{refreshToken:false},10000)
    if(account?.type!=='chatgpt')throw Error('请在本机使用官方 Codex 登录 ChatGPT')
    return createHash('sha256').update(String(account.email??'local-chatgpt')).digest('hex')
  }
  async readUsage():Promise<UsageWindow[]>{
    const result=await this.rpc.request('account/rateLimits/read',{},5000)
    const limits=result?.rateLimitsByLimitId?.codex??result?.rateLimits
    return [limits?.primary,limits?.secondary].flatMap(window=>
      Number.isFinite(window?.usedPercent)&&window.usedPercent>=0&&window.usedPercent<=100?[{
        usedPercent:window.usedPercent,
        durationMinutes:Number.isSafeInteger(window.windowDurationMins)&&window.windowDurationMins>0?window.windowDurationMins:null,
        resetsAt:Number.isSafeInteger(window.resetsAt)&&window.resetsAt>0?window.resetsAt:null
      }]:[])
  }
  endings=new Map<string,{finish:()=>void,fail:(err:Error)=>void}>()
  private starts=new Map<Run,Promise<unknown>>()
  async probe() {
    const hello=await this.rpc.request('initialize',{clientInfo:{name:'xiaomaoqiu',title:'小毛球工作台',version:'1.0.0'},capabilities:{}})
    await this.rpc.write({method:'initialized'})
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
    const [steer,cancel,history,nativeHistory,fork,archive,unarchive]=await Promise.all(
      ['turn/steer','turn/interrupt','thread/read','thread/turns/list','thread/fork','thread/archive','thread/unarchive'].map(supported))
    const nativeActions:NativeAction[]=[]
    if(fork)nativeActions.push('fork')
    if(archive&&unarchive)nativeActions.push('archive','unarchive')
    let sessionList=false
    if(history)try{await this.catalog({limit:1});sessionList=true}catch{}
    return {availableActions:['run','prepare','answer',...(steer?['steer']:[]),...(cancel?['cancel']:[])],
      version:hello.userAgent,resume:true,history,sessionList,sessionImport:sessionList,nativeHistory,nativeActions,models:this.models}
  }
  private async catalog(options:object){
    const result=await this.rpc.request('thread/list',{...options,cwd:this.instance.workspaceRef,currentAccountOnly:true,useStateDbOnly:true},5000)
    if(!Array.isArray(result?.data))throw Error('Codex 未提供可核对的会话目录')
    return {...result,data:result.data.filter((thread:any)=>typeof thread.id==='string'&&typeof thread.cwd==='string'&&
      relative(this.instance.workspaceRef,thread.cwd)===''&&!thread.ephemeral)}
  }
  async listSessions(cursor?:string){
    const result=await this.catalog({limit:35,sortKey:'updated_at',cursor})
    return {items:result.data.map((thread:any)=>({id:thread.id,title:String(thread.name||thread.preview||'Codex 话题').slice(0,140),
      updatedAt:Number(thread.updatedAt)||0,active:thread.status?.type==='active'||this.active.has(thread.id)})),
      nextCursor:typeof result.nextCursor==='string'?result.nextCursor:null}
  }
  async importSession(sessionId:string){
    const {data}=await this.catalog({includedThreadIds:[sessionId],limit:1})
    if(!data.some((thread:any)=>thread.id===sessionId))throw Error('找不到当前工作区、账号和 profile 下的外部会话')
    const {thread}=await this.rpc.request('thread/read',{threadId:sessionId,includeTurns:false},5000)
    if(thread?.id!==sessionId||typeof thread.cwd!=='string'||relative(this.instance.workspaceRef,thread.cwd)!=='')
      throw Error('外部会话的工作区不匹配')
    if(!['idle','notLoaded'].includes(thread.status?.type)||this.active.has(sessionId))throw Error('原生会话仍在运行或状态不可核对，请先在原客户端检查')
    try{return await this.open(sessionId)}
    catch(e){
      if(/already has an active writer/i.test((e as Error).message))
        throw Error('该原生会话仍被其他客户端占用，请在原客户端释放会话后再导入')
      throw e
    }
  }
  async open(sessionId?:string) {
    if(sessionId && this.sessions.has(sessionId)) return sessionId
    const method=sessionId?'thread/resume':'thread/start'
    const {thread,model}=await this.rpc.request(method,{cwd:this.instance.workspaceRef,...(sessionId?{threadId:sessionId,excludeTurns:true}:{})})
    if(!thread?.id || (sessionId && thread.id!==sessionId) || relative(resolve(thread.cwd),this.instance.workspaceRef)!=='')
      throw new Error('原生工作区或线程不符')
    this.sessions.add(thread.id)
    if(typeof model==='string')this.sessionModels.set(thread.id,model)
    return thread.id as string
  }
  async readHistory(sessionId:string,before?:string):Promise<NativeHistory>{
    const {thread}=await this.rpc.request('thread/read',{threadId:sessionId,includeTurns:false},5000)
    if(thread?.id!==sessionId||typeof thread.cwd!=='string'||relative(this.instance.workspaceRef,thread.cwd)!=='')throw Error('原生历史工作区不匹配')
    const page=await this.rpc.request('thread/turns/list',{threadId:sessionId,limit:6,sortDirection:'desc',itemsView:'full',cursor:before},5000)
    if(!Array.isArray(page.data))throw Error('原生历史读取失败')
    const items:NativeHistory['items']=[]
    let bytes=0
    for(const turn of page.data.reverse())for(const item of turn.items??[]){
      if(typeof item.id!=='string'||typeof turn.id!=='string'||!['userMessage','agentMessage'].includes(item.type))continue
      const text=item.type==='agentMessage'?item.text:(item.content??[]).filter((part:any)=>part.type==='text').map((part:any)=>part.text).join('\n')
      if(typeof text!=='string'||!text.trim())continue
      bytes+=Buffer.byteLength(text)
      if(bytes>2*1024*1024)throw Error('此页原生历史过大，请在原生客户端查看')
      items.push({id:item.id,turnId:turn.id,role:item.type==='agentMessage'?'assistant':'user',text})
    }
    // Absence from a filtered page is insufficient evidence of external deletion.
    let archived:boolean|undefined
    for(const value of [false,true]){
      try{
        const found=await this.catalog({includedThreadIds:[sessionId],archived:value,limit:1})
        if(found.data.some((t:any)=>t.id===sessionId)){archived=value;break}
      }catch{break}
    }
    return {items,nextBefore:page.nextCursor??null,archived}
  }
  async sessionAction(action:NativeAction,sessionId:string){
    if(action==='delete')throw Error('此 Codex 适配器未提供原生删除')
    if(this.active.has(sessionId))throw Error('原生会话仍在运行')
    const original=await this.rpc.request('thread/read',{threadId:sessionId,includeTurns:false},5000)
    if(original.thread?.id!==sessionId||typeof original.thread.cwd!=='string'||
      relative(this.instance.workspaceRef,original.thread.cwd)!==''||original.thread.status?.type==='active')throw Error('原生工作区或空闲状态无法核对')
    const result=await this.rpc.request('thread/'+action,{threadId:sessionId,...(action==='fork'?{cwd:this.instance.workspaceRef}:{})})
    if(action==='archive'){this.sessions.delete(sessionId);return sessionId}
    const thread=result.thread
    if(typeof thread?.id!=='string'||typeof thread.cwd!=='string'||relative(this.instance.workspaceRef,thread.cwd)!==''||
      (action==='fork'?thread.id===sessionId:thread.id!==sessionId))throw Error('原生会话操作回执不匹配')
    if(action==='fork')this.sessions.add(thread.id)
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
      const start=this.rpc.request('turn/start',{threadId:run.sessionId,input:inputs(input),...(model?{model}:{})})
      this.starts.set(run,start)
      const {turn}=await start
      if(run.nativeRunId && run.nativeRunId!==turn.id) throw new Error('原生回执运行 ID 不一致')
      if(!run.nativeRunId) {run.nativeRunId=turn.id;run.emit('accepted',{sessionId:run.sessionId,nativeRunId:turn.id})}
      if(model){
        this.sessionModels.set(run.sessionId,model)
        run.emit('model_state',{sessionId:run.sessionId,current:model,options:this.models})
      }
      await end.promise
    } finally {
      this.starts.delete(run)
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
    if(!run.nativeRunId)await this.starts.get(run)
    if(!run.nativeRunId) throw new Error('尚未收到原生运行回执')
    if(this.active.get(run.sessionId)!==run)throw new Error('原生运行已经结束')
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
