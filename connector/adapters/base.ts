import {randomUUID} from 'node:crypto'
import {Rpc} from '../rpc.ts'
import type {Instance,Run} from '../types.ts'

export abstract class Native {
  instance: Instance
  rpc: Rpc
  sessions=new Set<string>()
  active=new Map<string,Run>()
  requests=new Map<string,{run:Run,choices:string[],reply:(choice:string)=>Promise<void>}>()
  constructor(instance:Instance) {
    this.instance=instance
    this.rpc=new Rpc(instance)
    this.rpc.on('incoming',msg=>{
      try {this.incoming(msg)} catch(error) {
        if(msg.id != null && !this.rpc.closed) this.rpc.send({id:msg.id,error:{code:-32603,message:'无法处理原生请求'}})
        console.error('原生消息处理失败',String(error))
      }
    })
  }
  abstract incoming(msg:any):void
  onDisconnect(handler:(error:Error)=>void) {this.rpc.once('closed',handler)}
  ask(run:Run,text:string,options:{id:string,label:string}[],reply:(choice:string)=>Promise<void>) {
    const requestId=randomUUID()
    const choices=options.map(x=>x.id)
    this.requests.set(requestId,{run,choices,reply})
    run.emit('input_required',{requestId,text,options,choices})
  }
  async answer(run:Run,id:string,choice:string) {
    const pending=this.requests.get(id)
    if(!pending || pending.run !== run || !pending.choices.includes(choice))
      throw Object.assign(new Error('请求已过期或选项无效'),{code:-32602})
    this.requests.delete(id)
    await pending.reply(choice)
  }
  finish(run:Run) {
    this.active.delete(run.sessionId)
    for(const [id,pending] of this.requests) if(pending.run===run) this.requests.delete(id)
  }
  close() {this.rpc.close()}
}
