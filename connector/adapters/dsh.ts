import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {relative} from 'node:path'
import {Native} from './base.ts'
import type {Run,Input,Adapter} from '../types.ts'
import type {ModelOption,ModelState,NativeAction,NativeSession} from '../../contracts/node.ts'

type DshModelState=ModelState & {configId?:string}

function modelOption(id:string,name:unknown,group?:string):ModelOption {
  // DSH uses a JSON tuple for provider-qualified models. Keep its wire value intact.
  let provider=group
  if(id.startsWith('[')){
    try{
      const pair:unknown=JSON.parse(id)
      if(Array.isArray(pair) && pair.length===2 && pair.every(part=>typeof part==='string')){
        provider=pair[0]
        name=typeof name==='string'&&name?name:pair[1]
      }
    }catch{}
  }
  const label=typeof name==='string'&&name?name:id
  return {id,label:provider?`${label} · ${provider}`:label}
}

function choices(options:any[],group?:string):ModelOption[]{
  return options.flatMap(item=>Array.isArray(item?.options)?choices(item.options,typeof item.name==='string'?item.name:group):
    typeof item?.value==='string'&&item.value?[modelOption(item.value,item.name,group)]:[])
}

function readModels(result:any):DshModelState|undefined {
  const configOptions=result?.configOptions
  const option=Array.isArray(configOptions)?configOptions.find((v:any)=>
    v?.type==='select' && typeof v.id==='string' && (v.category==='model'||v.id==='model')):undefined
  if(option)return {configId:option.id,current:typeof option.currentValue==='string'?option.currentValue:null,
    options:Array.isArray(option.options)?choices(option.options):[]}
  const legacy=result?.models
  if(Array.isArray(legacy?.availableModels))return {current:typeof legacy.currentModelId==='string'?legacy.currentModelId:null,
    options:legacy.availableModels.flatMap((m:any)=>typeof m?.modelId==='string'&&m.modelId?[modelOption(m.modelId,m.name)]:[])}
  // An explicitly replaced config with no model selector clears the cached options.
  if(Array.isArray(configOptions))return {current:null,options:[]}
}

export class Dsh extends Native implements Adapter {
  resume=false
  load=false
  images=false
  sessionList=false
  nativeActions:NativeAction[]=[]
  accepted=new Set<string>()
  messages=new Map<string,string>()
  private modelState=new Map<string,DshModelState>()
  private opening=0
  private openingModels=new Map<string,DshModelState>()
  private cancelBeforePrompt=new Set<string>()
  private cacheModels(sessionId:string,state:DshModelState){
    this.modelState.set(sessionId,state)
    const run=this.active.get(sessionId)
    if(run)this.reportModels(run)
  }
  reportModels(run:Run){
    run.emit('model_state',{sessionId:run.sessionId,...this.describeModels(run.sessionId)})
  }
  describeModels(sessionId:string):ModelState{
    const model=this.modelState.get(sessionId)
    return {current:model?.current??null,options:model?.options??[]}
  }
  flush(run:Run) {
    const text=this.messages.get(run.command.runId)
    if(text) run.emit('message',{text})
    this.messages.delete(run.command.runId)
  }
  async probe() {
    const hello=await this.rpc.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'xiaomaoqiu',version:'1.0.0'}})
    if(hello.protocolVersion!==1) throw new Error('不支持此 ACP 协议版本')
    const caps=hello.agentCapabilities||{}
    this.resume=!!caps.sessionCapabilities?.resume
    this.load=!!caps.loadSession
    this.images=!!caps.promptCapabilities?.image
    this.sessionList=!!caps.sessionCapabilities?.list
    this.nativeActions=(['fork','delete'] as const).filter(action=>!!caps.sessionCapabilities?.[action])
    return {availableActions:['run','prepare','cancel','answer'],sessionList:this.sessionList,nativeActions:this.nativeActions,
      resume:this.resume||this.load,history:false,version:hello.agentInfo?.version}
  }
  async listSessions(cursor?:string):Promise<{items:NativeSession[];nextCursor:string|null}>{
    if(!this.sessionList)throw Error('ACP 未声明会话目录能力')
    const page=await this.rpc.request('session/list',{cwd:this.instance.workspaceRef,cursor},5000)
    if(!Array.isArray(page.sessions))throw Error('ACP 会话目录回执无效')
    const items=page.sessions.filter((s:any)=>typeof s.sessionId==='string'&&typeof s.cwd==='string'&&relative(this.instance.workspaceRef,s.cwd)==='')
      .map((s:any)=>({id:s.sessionId,title:String(s.title||'ACP 会话').slice(0,140),updatedAt:Math.floor((Date.parse(s.updatedAt)||0)/1000),active:this.active.has(s.sessionId)}))
    return {items,nextCursor:typeof page.nextCursor==='string'?page.nextCursor:null}
  }
  async importSession(sessionId:string){
    if(!this.resume&&!this.load)throw Error('ACP 未声明原生续接能力')
    let cursor:string|undefined
    const seen=new Set<string>()
    do{
      const page=await this.listSessions(cursor)
      if(page.items.some(s=>s.id===sessionId))return this.open(sessionId)
      cursor=page.nextCursor??undefined
      if(cursor&&seen.has(cursor))throw Error('ACP 目录返回重复游标')
      if(cursor)seen.add(cursor)
    }while(cursor&&seen.size<=100)
    throw Error('在该实例已核对的目录页中未找到此会话')
  }
  async sessionAction(action:NativeAction,sessionId:string){
    if(!this.nativeActions.includes(action)||this.active.has(sessionId))throw Error('ACP 未授权此操作或会话正在运行')
    if(action==='delete'){
      await this.rpc.request('session/delete',{sessionId})
      this.sessions.delete(sessionId)
      return sessionId
    }
    const result=await this.rpc.request('session/fork',{sessionId,cwd:this.instance.workspaceRef,mcpServers:[]})
    if(typeof result?.sessionId!=='string'||!result.sessionId||result.sessionId===sessionId)throw Error('ACP 分支回执不匹配')
    this.sessions.add(result.sessionId)
    const state=readModels(result)
    if(state)this.cacheModels(result.sessionId,state)
    return result.sessionId as string
  }
  async open(sessionId?:string) {
    if(sessionId && this.sessions.has(sessionId)) return sessionId
    this.opening++
    try {
      const params={cwd:this.instance.workspaceRef,mcpServers:[]}
      let result
      if(sessionId) {
        if(!this.resume && !this.load) throw new Error('该 ACP 实例未宣布可恢复会话')
        result=await this.rpc.request(this.resume?'session/resume':'session/load',{sessionId,...params})
        if(result?.sessionId && result.sessionId!==sessionId)throw Error('ACP 返回另一会话 ID')
      } else {
        result=await this.rpc.request('session/new',params)
        sessionId=result?.sessionId
      }
      if(typeof sessionId!=='string'||!sessionId) throw new Error('ACP 未返回会话 ID')
      const state=readModels(result)??this.openingModels.get(sessionId)
      if(state)this.cacheModels(sessionId,state)
      this.openingModels.delete(sessionId)
      this.sessions.add(sessionId)
      return sessionId
    } finally {
      this.opening--
      if(!this.opening)this.openingModels.clear()
    }
  }
  confirm(run:Run) {
    if(this.accepted.has(run.command.runId)) return
    this.accepted.add(run.command.runId)
    run.emit('accepted',{sessionId:run.sessionId})
  }
  async setModel(sessionId:string,selected:string) {
    const model=this.modelState.get(sessionId)
    if(selected===model?.current)return
    if(!model?.options?.some(m=>m.id===selected))throw Error('当前 DSH 会话未提供所选模型')
    if(model.configId){
      const result=await this.rpc.request('session/set_config_option',{sessionId,configId:model.configId,value:selected})
      const state=readModels(result)
      if(state)this.cacheModels(sessionId,state)
      if(this.modelState.get(sessionId)?.current!==selected)throw Error('DSH 未确认选择')
    }else{
      await this.rpc.request('session/set_model',{sessionId,modelId:selected})
      this.modelState.set(sessionId,{...model,current:selected})
    }
  }
  async run(run:Run,input:Input) {
    this.reportModels(run)
    const selected=run.command.payload.modelId
    if(selected){
      try{
        await this.setModel(run.sessionId,selected)
        if(this.describeModels(run.sessionId).current!==selected)throw Error('原生会话已更新模型')
      }catch(err){
        this.reportModels(run)
        throw Object.assign(new Error('未开始运行，DSH 模型切换失败：'+(err as Error).message),{code:-32602})
      }
      this.reportModels(run)
    }
    if(this.cancelBeforePrompt.delete(run.command.runId)){
      run.emit('cancelled',{text:'提示尚未发送时运行已取消',sessionId:run.sessionId})
      return
    }
    const prompt:any[]=[{type:'text',text:input.text}]
    for(const file of input.files) {
      if(this.images && file.mime.startsWith('image/'))
        prompt.push({type:'image',mimeType:file.mime,data:readFileSync(file.path).toString('base64')})
      else prompt.push({type:'resource_link',name:file.name,uri:pathToFileURL(file.path).href,mimeType:file.mime})
    }
    this.active.set(run.sessionId,run)
    try {
      const result=await this.rpc.request('session/prompt',{sessionId:run.sessionId,prompt},0,()=>{
        run.emit('activity',{sessionId:run.sessionId,controlReady:true,text:'已写入原生 ACP 提示'})
      })
      this.confirm(run)
      this.flush(run)
      const kind=result.stopReason==='cancelled'?'cancelled':result.stopReason==='end_turn'?'completed':'blocked'
      run.emit(kind,{text:kind==='completed'?'':result.stopReason,stopReason:result.stopReason,sessionId:run.sessionId})
    } finally {
      this.flush(run)
      this.accepted.delete(run.command.runId)
      this.finish(run)
    }
  }
  incoming(msg:any) {
    const p=msg.params||{}
    const run=this.active.get(p.sessionId)
    if(msg.method==='session/update' && p.update?.sessionUpdate==='config_option_update' && typeof p.sessionId==='string'){
      const state=readModels(p.update)
      // RPC replies and notifications can arrive in one stdio read. Apply snapshots in wire order.
      if(state)queueMicrotask(()=>{
        if(this.sessions.has(p.sessionId))this.cacheModels(p.sessionId,state)
        else if(this.opening)this.openingModels.set(p.sessionId,state)
      })
      return
    }
    if(msg.method==='session/request_permission' && run) {
      this.confirm(run)
      this.flush(run)
      this.ask(run,p.toolCall?.title||'DSH 请求授权',(p.options||[]).map((x:any)=>({id:x.optionId,label:x.name})),
        choice=>this.rpc.write({id:msg.id,result:{outcome:{outcome:'selected',optionId:choice}}}))
    } else if(msg.method==='session/update' && run) {
      const u=p.update
      if(u.sessionUpdate==='agent_message_chunk' && u.content?.type==='text') {
        this.confirm(run)
        this.messages.set(run.command.runId,(this.messages.get(run.command.runId)||'')+u.content.text)
      } else if(['tool_call','tool_call_update'].includes(u.sessionUpdate)) {
        this.confirm(run)
        this.flush(run)
        run.emit('activity',{text:u.title||u.toolCallId,itemId:u.toolCallId,status:u.status,stage:u.sessionUpdate})
      }
    } else if(msg.id!=null) this.rpc.send({id:msg.id,error:{code:-32601,message:'Unsupported client method'}})
  }
  async cancel(run:Run) {
    if(!this.active.has(run.sessionId)){
      this.cancelBeforePrompt.add(run.command.runId)
      return
    }
    await this.rpc.write({method:'session/cancel',params:{sessionId:run.sessionId}})
  }
}
