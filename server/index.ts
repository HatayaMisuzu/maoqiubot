import { createServer } from 'node:http'
import type { IncomingMessage,ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve,extname,sep } from 'node:path'
import { pathToFileURL,fileURLToPath } from 'node:url'
import { openDatabase, transaction, one, fail, owner } from './db/index.ts'
import { access,hash,secret } from './api/auth.ts'
import { route } from './api/routes.ts'
import { attachNodes } from './api/nodes.ts'
import { mainWorker } from './chat/index.ts'
import { homeRead } from './tasks/index.ts'
import { isLocal } from './api/local.ts'

const webRoot=fileURLToPath(new URL('../web-demo/',import.meta.url))
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2'}
async function body(req:IncomingMessage){
  const chunks:Buffer[]=[];let size=0
  for await(const chunk of req){size+=chunk.length;if(size>24*1024*1024)fail('请求超过 24 MiB',413);chunks.push(chunk)}
  if(!size)return {}
  if(!req.headers['content-type']?.startsWith('application/json'))fail('请发送 application/json',415)
  try{const b=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!b||typeof b!=='object'||Array.isArray(b))throw Error();return b}catch{fail('JSON 请求体无效')}
}
function json(res:ServerResponse,status:number,value:any){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'})
  res.end(JSON.stringify(value))
}
const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v
export function startServer(opts:{dataDir?:string,port?:number,host?:string,chat?:boolean}={}){
  const dataDir=resolve(opts.dataDir??process.env.MAOQIU_DATA??'data'),db=openDatabase(dataDir),auth=access(dataDir)
  const ticket=secret(), sessions=new Set<string>();let ticketExpires=Date.now()+5*60000
  const streams=new Map<ServerResponse,number>()
  const chat=mainWorker(db,dataDir)
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff')
    res.setHeader('Referrer-Policy','no-referrer')
    try{
      const url=new URL(req.url??'/','http://localhost'),method=req.method??'GET'
      const host=req.headers.host??''
      if(req.headers.origin && new URL(req.headers.origin).host!==host)fail('来源不匹配',403)
      if(url.pathname==='/login'&&method==='GET'){
        if(ticketExpires<=Date.now()||url.searchParams.get('ticket')!==ticket)fail('登录链接已使用或已过期',403)
        ticketExpires=0
        const sid=secret();sessions.add(sid)
        res.writeHead(303,{'Location':'/','Cache-Control':'no-store','Set-Cookie':'maoqiu='+sid+'; HttpOnly; SameSite=Strict; Path=/'});res.end();return
      }
      if(!url.pathname.startsWith('/api/v1/')){
        if(method!=='GET')fail('接口不存在',404)
        const rel=decodeURIComponent(url.pathname.slice(1))||'index.html'
        const file=resolve(webRoot,rel)
        if(!file.startsWith(resolve(webRoot)+sep)||!mime[extname(file)])fail('页面不存在',404)
        let buf:Buffer
        try{buf=readFileSync(file)}catch{fail('页面不存在',404)}
        res.writeHead(200,{'Content-Type':mime[extname(file)],'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"});res.end(buf);return
      }
      const path=url.pathname.slice('/api/v1'.length),token=req.headers.authorization?.replace(/^Bearer /,'')??''
      const cookie=req.headers.cookie?.match(/(?:^|;\s*)maoqiu=([\w-]+)/)?.[1]
      const principal=auth.principal(db,token)??(!token&&cookie&&sessions.has(cookie)?owner:undefined)
      if(!principal){
        const nodeId=auth.node(token),m=path.match(/^\/attachments\/([^/]+)$/)
        if(method==='GET'&&nodeId&&m){
          const c=one(db,`SELECT c.payload,t.projectId FROM commands c
            JOIN instances i ON i.id=c.instanceId
            JOIN threads t ON t.id=c.threadId
            JOIN runs r ON r.id=c.runId
            WHERE c.id=? AND i.nodeId=? AND c.kind IN ('run','steer') AND c.status IN ('sent','received')
              AND r.status IN ('queued','running','waiting_input','cancelling')`,url.searchParams.get('commandId'),nodeId)
          if(!c||!JSON.parse(c.payload).attachmentIds?.includes(m[1]))fail('附件未随此命令授权',403)
          return json(res,200,homeRead(db,dataDir,path,c.projectId))
        }
        fail('请使用工作台访问令牌登录',401)
      }
      if(path==='/events'&&method==='GET'){
        if(!principal.owner)fail('此授权不含工作台事件',403)
        const cursor=Number(req.headers['last-event-id']??url.searchParams.get('after')??0)
        if(!Number.isSafeInteger(cursor)||cursor<0)fail('游标无效')
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'})
        res.write(': connected\n\n');streams.set(res,cursor);res.on('close',()=>streams.delete(res));broadcast();return
      }
      const b=method==='GET'?{}:await body(req)
      if(['POST','PATCH','DELETE'].includes(method) && b.requestId!=null && (typeof b.requestId!=='string'||!b.requestId.length||b.requestId.length>256))fail('requestId 无效')
      const result=transaction(db,()=>{
        const signature=b.requestId?hash(JSON.stringify([method,path,stable(b)])):null
        if(signature){
          const previous=one(db,'SELECT * FROM requests WHERE principal=? AND requestId=?',principal.id,b.requestId)
          if(previous){
            if(previous.signature!==signature) fail('相同 requestId 的内容不同',409)
            return JSON.parse(previous.result)
          }
        }
        const value=route(db,{method,path,query:url.searchParams,body:b,principal,dataDir,localRequest:isLocal(req)})
        if(signature) db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(principal.id,b.requestId,signature,JSON.stringify(value))
        return value
      })
      json(res,200,result)
      if(method!=='GET'){nodes.flush();broadcast();if(opts.chat!==false)void chat()}
    }catch(e:any){if(!e.status)console.error(e);if(!res.headersSent)json(res,e.status??500,{error:e.status?e.message:'服务端处理失败',current:e.current});else res.end()}
  })
  const nodes=attachNodes(server,db,auth.node)
  function broadcast(){for(const [res,after] of streams){
    if(res.writableNeedDrain)continue
    const events=db.prepare('SELECT * FROM events WHERE cursor>? ORDER BY cursor LIMIT 200').all(after)
    for(const e of events){const value={...JSON.parse(String(e.body)),kind:e.kind,cursor:e.cursor};const ok=res.write('id: '+e.cursor+'\ndata: '+JSON.stringify(value)+'\n\n');streams.set(res,Number(e.cursor));if(!ok)break}
  }}
  const interval=setInterval(()=>{nodes.flush();broadcast();if(opts.chat!==false)void chat()},500)
  const heartbeat=setInterval(()=>{for(const r of streams.keys())if(!r.writableNeedDrain)r.write(': heartbeat\n\n')},15000)
  server.on('close',()=>{clearInterval(interval);clearInterval(heartbeat)})
  const port=opts.port??Number(process.env.PORT??4317),host=opts.host??process.env.HOST??'127.0.0.1'
  server.listen(port,host)
  return {server,db,auth,ticket,dataDir,async close(){
    clearInterval(interval);clearInterval(heartbeat);nodes.close()
    for(const r of streams.keys())r.end()
    await new Promise<void>((done)=>server.close(()=>done()))
    db.close()
  }}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const app=startServer()
  app.server.once('listening',()=>{const a=app.server.address() as any;console.log('小毛球工作台 http://'+(a.address.includes(':')?'['+a.address+']':a.address)+':'+a.port+'/login?ticket='+app.ticket);console.log('数据目录 '+app.dataDir)})
}
