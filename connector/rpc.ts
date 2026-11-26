import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import type {Instance} from './types.ts'
import {codexEnvironment,codexServiceArgs} from '../contracts/codex-local.ts'

// Both protocols use newline-delimited JSON-RPC over private stdio.
export class Rpc extends EventEmitter {
  process: ChildProcessWithoutNullStreams
  next = 0
  closed = false
  pending = new Map<number,{ok:(value:any)=>void, fail:(err:Error)=>void}>()
  constructor(instance: Instance) {
    super()
    const codex=instance.adapterKey==='codex'
    if(codex && instance.args.join(' ')!=='app-server') throw Error('Codex 实例只接受官方 app-server stdio 入口')
    const env = codex?codexEnvironment({...process.env,...instance.env}):{...process.env,...instance.env}
    for(const key of Object.keys(env))if(/^(?:(?:NODE|OWNER)_TOKEN$|MAOQIU_MODEL_KEY_)/i.test(key))delete env[key]
    const args=codex?['app-server','--listen','stdio://',...codexServiceArgs]:instance.args
    const batch=process.platform==='win32'&&instance.adapterKey==='dsh'&&/\.cmd$/i.test(instance.command)
    // Windows requires cmd.exe for the vendor-provided dsh.cmd launcher.
    if(batch && [instance.command,...args].some(arg=>/[%!&|^"<>\r\n]/.test(arg)))throw Error('DSH 批处理启动参数包含不支持的字符')
    const executable=batch?(process.env.ComSpec||'cmd.exe'):instance.command
    const argv=batch?['/d','/s','/c','"'+[instance.command,...args].map(x=>'"'+x+'"').join(' ')+'"']:args
    this.process = spawn(executable, argv, {
      cwd:instance.workspaceRef, env, windowsHide:true, stdio:'pipe', shell:false,windowsVerbatimArguments:batch
    })
    this.process.stderr.resume()
    this.process.stdin.on('error', e => this.stop(e))
    this.process.once('error', e => this.stop(e))
    // `exit` can arrive before the last terminal JSON-RPC response has drained.
    this.process.once('close', (code,signal) => this.stop(new Error('原生进程已退出 '+(code ?? signal))))
    const lines = createInterface({input:this.process.stdout})
    lines.on('line', line => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if(!msg||typeof msg!=='object'||Array.isArray(msg))return
      if (typeof msg.method==='string') this.emit('incoming',msg)
      else if (this.pending.has(msg.id)) {
        const waiter = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if ('error' in msg && !('result' in msg) && Number.isInteger(msg.error?.code) && typeof msg.error?.message==='string')
          waiter.fail(Object.assign(new Error(msg.error.message),{code:msg.error.code}))
        else if ('result' in msg && !('error' in msg)) waiter.ok(msg.result)
        else waiter.fail(new Error('原生响应格式无效，无法核对请求结果'))
      }
    })
  }
  stop(err:Error) {
    if (this.closed) return
    this.closed = true
    for(const waiter of this.pending.values()) waiter.fail(err)
    this.pending.clear()
    this.emit('closed',err)
  }
  send(msg:object,written?:(err?:Error|null)=>void) {
    if(this.closed) throw new Error('原生连接已关闭')
    this.process.stdin.write(JSON.stringify({jsonrpc:'2.0',...msg})+'\n',written)
  }
  write(msg:object) {
    return new Promise<void>((ok,fail)=>this.send(msg,error=>error?fail(error):ok()))
  }
  request(method:string,params:object,timeout=30000,submitted?:()=>void):Promise<any> {
    return new Promise((ok,fail) => {
      const id = ++this.next
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id)
        fail(new Error(method+' 等待原生响应超时'))
      },timeout) : undefined
      this.pending.set(id,{ok:v=>{clearTimeout(timer);ok(v)},fail:e=>{clearTimeout(timer);fail(e)}})
      const written=submitted?(error?:Error|null)=>{
        const pending=this.pending.get(id)
        if(!pending)return
        try {
          if(error)throw error
          submitted()
        }catch(e){this.pending.delete(id);pending.fail(e as Error)}
      }:undefined
      try {this.send({id,method,params},written)} catch(e) {clearTimeout(timer); this.pending.delete(id);fail(e)}
    })
  }
  close() {
    this.process.stdin.end()
    this.process.kill()
    this.stop(new Error('原生连接已关闭'))
  }
}
