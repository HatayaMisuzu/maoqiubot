import {join,relative} from 'node:path'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {Native} from './base.ts'
import {agentEnvironment} from '../rpc.ts'
import type {Input,Run,Adapter} from '../types.ts'
import type {ModelOption,ModelState,NativeAction,NativeHistory,UsageWindow} from '../../contracts/node.ts'

function inputs(input:Input) {
  return [{type:'text',text:input.text,text_elements:[]},...input.files.map(f=>f.mime.startsWith('image/')
    ? {type:'localImage',path:f.path}
    : {type:'text',text:'用户附件 '+f.name+' ['+f.id+']\n'+f.path,text_elements:[]})]
}
const usageFields=['inputTokens','outputTokens','totalTokens'] as const
type TokenCounts=Record<typeof usageFields[number],number>
type TokenUsage=TokenCounts & {model:string|null}

function tokenCounts(value:any):TokenCounts|undefined {
  if(!value || !usageFields.every(key=>Number.isSafeInteger(value[key])&&value[key]>=0))return
  return {inputTokens:value.inputTokens,outputTokens:value.outputTokens,totalTokens:value.totalTokens}
}

function terminal(turn:any,emit:Run['emit'],usage?:TokenUsage) {
  const status=turn.status
  if(!['completed','interrupted','failed'].includes(status)) return false
  emit(status==='interrupted'?'cancelled':status,{
    text:turn.error?.message || '',nativeRunId:turn.id,...(status==='completed'&&usage?{usage}:{})
  })
  return true
}

const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
function orderedJson(value:unknown){
  return JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item)?
    Object.fromEntries(Object.entries(item).sort(([first],[second])=>first.localeCompare(second))):item)
}

export class Codex extends Native implements Adapter {
  turnStartTimeoutMs=30000
  models:ModelOption[]=[]
  sessionModels=new Map<string,string>()
  private providerId?:string
  private defaultModel?:string
  private officialQuota=true
  private turnUsage=new WeakMap<Run,{turnId:string,total:TokenCounts,used:TokenUsage}>()
  private reroutedModel=new WeakMap<Run,string>()
  async identity(){
    if(this.instance.codexProviderMode!=='native'){
      const {account}=await this.rpc.request('account/read',{refreshToken:false},10000)
      if(account?.type!=='chatgpt')throw Error('请在本机使用官方 Codex 登录 ChatGPT')
      if(typeof account.email!=='string'||!account.email.trim())throw Error('无法核对本机 Codex 登录账号')
      this.providerId='openai'
      return hash(account.email)
    }
    // Inspect the configuration Codex resolves for this cwd, including native project overrides.
    const {config}=await this.rpc.request('config/read',{cwd:this.instance.workspaceRef},10000)
    if(!config||typeof config!=='object'||Array.isArray(config))throw Error('无法核对本机 Codex 供应商配置')
    const providerId=config.model_provider??'openai'
    if(typeof providerId!=='string'||!providerId)throw Error('无法核对本机 Codex 供应商标识')
    const {account,userId,workspaceRouting,requiresOpenaiAuth}=await this.rpc.request('account/read',{refreshToken:false,modelProvider:providerId},10000)
    if(!account && requiresOpenaiAuth!==false)throw Error('请先在本机登录此 Codex 供应商')
    const defaultModel=typeof config.model==='string'&&config.model?config.model:undefined
    const officialQuota=providerId==='openai'&&account?.type==='chatgpt'&&!config.openai_base_url&&!config.chatgpt_base_url
    const provider=config.model_providers?.[providerId]
    const env=agentEnvironment(this.instance)
    const envNames=[provider?.env_key,...Object.values(provider?.env_http_headers??{}),
      ...(providerId==='openai'?['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','CHATGPT_BASE_URL']:[])]
    const routeEnv=Object.fromEntries(envNames.filter((key):key is string=>typeof key==='string').map(key=>[key,env[key]??null]))
    let fileKey:string|null=null
    if(account?.type==='apiKey'&&this.instance.env?.CODEX_HOME){
      // Only include the API key fingerprint. Refreshing a ChatGPT token must not invalidate its sessions.
      try{
        const localAuth=JSON.parse(readFileSync(join(this.instance.env.CODEX_HOME,'auth.json'),'utf8'))
        if(typeof localAuth.OPENAI_API_KEY==='string')fileKey=hash(localAuth.OPENAI_API_KEY)
      }catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('无法核对本机 Codex API 登录')
      }
    }
    this.providerId=providerId
    this.defaultModel=defaultModel
    this.officialQuota=officialQuota
    return hash(orderedJson([
      'native',providerId,config.openai_base_url,config.chatgpt_base_url,account?.type,account?.email,userId,
      workspaceRouting?.chatgptAccountId,workspaceRouting?.backendOrigin,routeEnv,fileKey,
      provider?.base_url,provider?.model_catalog_url,provider?.wire_api,provider?.auth,provider?.gateway_oauth,
      provider?.query_params,provider?.http_headers,provider?.experimental_bearer_token,provider?.credential_file,
      provider?.location,provider?.project_id,provider?.aws,provider?.requires_openai_auth
    ]))
  }
  async readUsage():Promise<UsageWindow[]>{
    if(!this.officialQuota)return []
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
  async initialize() {
    const hello=await this.rpc.request('initialize',{clientInfo:{name:'xiaomaoqiu',title:'小毛球工作台',version:'1.0.0'},capabilities:{}})
    await this.rpc.write({method:'initialized'})
    return hello
  }
  async probe() {
    const hello=await this.initialize()
    await this.identity()
    try{
      const result=await this.rpc.request('model/list',{limit:100,includeHidden:false,
        ...(this.providerId?{modelProvider:this.providerId}:{})},5000)
      this.models=result.data.filter((m:any)=>typeof m.model==='string' && !m.hidden).map((m:any)=>({id:m.model,label:m.displayName||m.model}))
    }catch{this.models=[]}
    if(this.defaultModel&&!this.models.some(model=>model.id===this.defaultModel))
      this.models.unshift({id:this.defaultModel,label:this.defaultModel})
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
    // Older native threads record only a provider ID. The same ID may now point to another account or endpoint.
    if(history&&(!this.providerId||this.officialQuota))try{await this.catalog({limit:1});sessionList=true}catch{}
    return {availableActions:['run','prepare','answer',...(steer?['steer']:[]),...(cancel?['cancel']:[])],
      version:hello.userAgent,resume:true,history,sessionList,sessionImport:sessionList,nativeHistory,nativeActions,models:this.models,
      usage:this.officialQuota}
  }
  private async catalog(options:object){
    const result=await this.rpc.request('thread/list',{...options,cwd:this.instance.workspaceRef,currentAccountOnly:true,useStateDbOnly:true},5000)
    if(!Array.isArray(result?.data))throw Error('Codex 未提供可核对的会话目录')
    return {...result,data:result.data.filter((thread:any)=>typeof thread.id==='string'&&typeof thread.cwd==='string'&&
      relative(this.instance.workspaceRef,thread.cwd)===''&&!thread.ephemeral&&
      (typeof thread.modelProvider!=='string'||thread.modelProvider===this.providerId))}
  }
  private matchesThread(thread:any,sessionId?:string){
    return typeof thread?.id==='string'&&(!sessionId||thread.id===sessionId)&&typeof thread.cwd==='string'&&
      relative(this.instance.workspaceRef,thread.cwd)===''&&(!this.providerId||thread.modelProvider===this.providerId)
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
    if(!this.matchesThread(thread,sessionId))throw Error('外部会话的工作区或供应商不匹配')
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
    const {thread,model}=await this.rpc.request(method,{cwd:this.instance.workspaceRef,
      ...(this.providerId?{modelProvider:this.providerId}:{}),
      ...(sessionId?{threadId:sessionId,excludeTurns:true}:{})})
    if(!this.matchesThread(thread,sessionId))throw new Error('原生工作区、线程或供应商不符')
    this.sessions.add(thread.id)
    if(typeof model==='string')this.sessionModels.set(thread.id,model)
    return thread.id as string
  }
  async readHistory(sessionId:string,before?:string):Promise<NativeHistory>{
    const {thread}=await this.rpc.request('thread/read',{threadId:sessionId,includeTurns:false},5000)
    if(!this.matchesThread(thread,sessionId))throw Error('原生历史工作区或供应商不匹配')
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
    if(!this.matchesThread(original.thread,sessionId)||original.thread.status?.type==='active')
      throw Error('原生工作区、供应商或空闲状态无法核对')
    const result=await this.rpc.request('thread/'+action,{threadId:sessionId,...(action==='fork'?{cwd:this.instance.workspaceRef}:{})})
    if(action==='archive'){this.sessions.delete(sessionId);return sessionId}
    const thread=result.thread
    if(!this.matchesThread(thread,action==='fork'?undefined:sessionId)||action==='fork'&&thread.id===sessionId)
      throw Error('原生会话操作回执不匹配')
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
      const start=this.rpc.request('turn/start',{threadId:run.sessionId,input:inputs(input),...(model?{model}:{})},this.turnStartTimeoutMs)
      this.starts.set(run,start)
      try {
        const result=await Promise.race([
          start.then(({turn})=>({turn})),
          end.promise.then(()=>({ended:true as const}))
        ])
        if(!('ended' in result)){
          const {turn}=result
          if(run.nativeRunId && run.nativeRunId!==turn.id) throw new Error('原生回执运行 ID 不一致')
          if(!run.nativeRunId) {run.nativeRunId=turn.id;run.emit('accepted',{sessionId:run.sessionId,nativeRunId:turn.id})}
          if(model){
            this.sessionModels.set(run.sessionId,model)
            run.emit('model_state',{sessionId:run.sessionId,current:model,options:this.models})
          }
        }
      } catch(error) {
        if(!run.nativeRunId)throw error
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
      if(!run.nativeRunId&&typeof p.turn?.id==='string'){
        run.nativeRunId=p.turn.id
        run.emit('accepted',{sessionId:run.sessionId,nativeRunId:p.turn.id})
      }
      const counts=this.turnUsage.get(run)
      const usage=counts&&counts.turnId===p.turn.id?counts.used:undefined
      if(terminal(p.turn,run.emit,usage)) this.endings.get(run.sessionId)?.finish()
    } else if(msg.method==='thread/tokenUsage/updated' && typeof p.turnId==='string' &&
      (!run.nativeRunId || p.turnId===run.nativeRunId)) {
      if(!run.nativeRunId)run.nativeRunId=p.turnId
      const total=tokenCounts(p.tokenUsage?.total),latest=tokenCounts(p.tokenUsage?.last)
      if(!total||!latest)return
      const previous=this.turnUsage.get(run)
      const currentModel=this.reroutedModel.get(run)??run.command.payload.modelId??this.sessionModels.get(run.sessionId)??null
      // Native totals are cumulative for the thread, and a turn can include multiple model requests.
      if(previous&&previous.turnId===p.turnId){
        if(usageFields.some(key=>total[key]<previous.total[key]))return
        if(usageFields.every(key=>total[key]===previous.total[key]))return
        const used=tokenCounts(Object.fromEntries(usageFields.map(key=>[key,previous.used[key]+total[key]-previous.total[key]])))
        if(used)this.turnUsage.set(run,{turnId:p.turnId,total,used:{...used,model:previous.used.model===currentModel?currentModel:null}})
      }else this.turnUsage.set(run,{turnId:p.turnId,total,used:{...latest,model:currentModel}})
    } else if(msg.method==='model/rerouted' && typeof p.toModel==='string') {
      this.reroutedModel.set(run,p.toModel)
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
    if(!this.matchesThread(thread,run.sessionId))return false
    const turn=thread.turns?.find((x:any)=>x.id===run.nativeRunId)
    if(!turn || !['completed','interrupted','failed'].includes(turn.status)) return false
    for(const item of turn.items??[]) if(item.type==='agentMessage') run.emit('message',{itemId:item.id,text:item.text})
    return terminal(turn,run.emit)
  }
}
