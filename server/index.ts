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
import type { ChatProvider } from './chat/provider.ts'
import { selectedModel } from './chat/model-settings.ts'
import { discoverModels, probeCapability, probeModel } from './chat/compatible.ts'
import { checkQueuedInput, homeRead, nativeSessionTarget } from './tasks/index.ts'
import { isLocal } from './api/local.ts'
import { pluginHost } from './plugins/host.ts'
import { coordinationWorker } from './chat/coordination.ts'
import { dueReminders } from './chat/daily.ts'
import { expireApprovals } from './chat/approval.ts'
import type { DesktopBridge } from './chat/tools.ts'

const webRoot=fileURLToPath(new URL('../web-demo/',import.meta.url))
const favicon=fileURLToPath(new URL('../desktop/icon.ico',import.meta.url))
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
export function startServer(opts:{dataDir?:string,port?:number,host?:string,chat?:boolean,chatProvider?:ChatProvider,desktop?:DesktopBridge}={}){
  const dataDir=resolve(opts.dataDir??process.env.MAOQIU_DATA??'data'),db=openDatabase(dataDir),auth=access(dataDir)
  const plugins=pluginHost(dataDir)
  const coordination=coordinationWorker(db,dataDir,plugins,opts.chatProvider)
  const ticket=secret(), sessions=new Set<string>();let ticketExpires=Date.now()+5*60000
  const streams=new Map<ServerResponse,number>()
  const chat=mainWorker(db,dataDir,opts.chatProvider,(threadId,messageId,text)=>{
    const data=JSON.stringify({kind:'chat_delta',threadId,messageId,text})
    for(const res of streams.keys())if(!res.writableNeedDrain&&!res.writableEnded)res.write('data: '+data+'\n\n')
  },plugins,{desktop:opts.desktop,listSessions:(inst,cursor)=>nodes.listSessions(inst,cursor)})
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff')
    res.setHeader('Referrer-Policy','no-referrer')
    try{
      const url=new URL(req.url??'/','http://localhost'),method=req.method??'GET'
      const host=req.headers.host??''
      if(req.headers.origin && new URL(req.headers.origin).host!==host)fail('来源不匹配',403)
      if(url.pathname==='/login'&&method==='GET'){
        if(!isLocal(req))fail('工作台登录链接限本机使用',403)
        if(ticketExpires<=Date.now()||url.searchParams.get('ticket')!==ticket)fail('登录链接已使用或已过期',403)
        ticketExpires=0
        const sid=secret();sessions.add(sid)
        res.writeHead(303,{'Location':'/','Cache-Control':'no-store','Set-Cookie':'maoqiu='+sid+'; HttpOnly; SameSite=Strict; Path=/'});res.end();return
      }
      if(!url.pathname.startsWith('/api/v1/')){
        if(method!=='GET')fail('接口不存在',404)
        const rel=decodeURIComponent(url.pathname.slice(1))||'index.html'
        const file=rel==='favicon.ico'?favicon:resolve(webRoot,rel)
        if((file!==favicon&&!file.startsWith(resolve(webRoot)+sep))||!mime[extname(file)])fail('页面不存在',404)
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
          const c=one(db,`SELECT c.*,t.projectId FROM commands c
            JOIN instances i ON i.id=c.instanceId
            JOIN threads t ON t.id=c.threadId
            JOIN runs r ON r.id=c.runId
            WHERE c.id=? AND i.nodeId=? AND c.kind IN ('run','steer') AND c.status IN ('sent','received')
              AND r.status IN ('queued','running','waiting_input','cancelling')`,url.searchParams.get('commandId'),nodeId)
          if(!c||!JSON.parse(c.payload).attachmentIds?.includes(m[1]))fail('附件未随此命令授权',403)
          checkQueuedInput(db,c,JSON.parse(c.payload))
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
      if(path==='/chat/plugins'&&['GET','POST'].includes(method)){
        if(!principal.owner||!isLocal(req))fail('插件管理限本机所有者',403)
        if(b.projectId)mustProject(b.projectId)
        await plugins.ready
        const ctrl=new AbortController()
        res.once('close',()=>{if(!res.writableEnded)ctrl.abort()})
        const result=method==='GET'?plugins.list():await plugins.manage(b,ctrl.signal)
        chat.revalidate()
        coordination.revalidate()
        return json(res,200,result)
      }
      const sessionCatalog=path.match(/^\/instances\/([\w-]{1,128})\/sessions$/)
      if(method==='GET'&&sessionCatalog){
        if(!principal.owner||!isLocal(req))fail('原生会话目录限本机所有者',403)
        const cursor=url.searchParams.get('cursor')
        if(cursor&&cursor.length>2000)fail('原生会话游标无效')
        const inst=nativeSessionTarget(db,sessionCatalog[1],url.searchParams.get('projectId')||null)
        return json(res,200,await nodes.listSessions(inst,cursor))
      }
      if(method==='POST'&&['/chat/models/test','/chat/models/discover','/chat/models/capability'].includes(path)){
        if(!principal.owner||!isLocal(req))fail('模型测试限本机所有者',403)
        const config=selectedModel(dataDir,typeof b.id==='string'?b.id:undefined)
        if(!config)fail('本机 Codex 通过主聊发送消息测试，模型目录由官方客户端管理',409)
        const ctrl=new AbortController()
        res.once('close',()=>{if(!res.writableEnded)ctrl.abort()})
        const result=await (path.endsWith('/discover')?discoverModels(config,ctrl.signal):
          path.endsWith('/capability')?probeCapability(config,b.capability,ctrl.signal):probeModel(config,ctrl.signal))
        return json(res,200,result)
      }
      if(['POST','PATCH','DELETE'].includes(method) && b.requestId!=null && (typeof b.requestId!=='string'||!b.requestId.length||b.requestId.length>256))fail('requestId 无效')
      const result=transaction(db,()=>{
        if(method!=='GET' && token && !principal.owner && !auth.principal(db,token))fail('项目资料授权已失效',401)
        const signature=b.requestId?hash(JSON.stringify([method,path,stable(b)])):null
        if(signature){
          const previous=one(db,'SELECT * FROM requests WHERE principal=? AND requestId=?',principal.id,b.requestId)
          if(previous){
            if(previous.signature!==signature) fail('相同 requestId 的内容不同',409)
            return JSON.parse(previous.result)
          }
        }
        const value=route(db,{method,path,query:url.searchParams,body:b,principal,dataDir,localRequest:isLocal(req),plugins})
        if(signature) db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(principal.id,b.requestId,signature,JSON.stringify(value))
        return value
      })
      if(method==='GET' && /^\/attachments\/[^/]+$/.test(path)){
        if(url.searchParams.get('download')==='1' && typeof result.data==='string'){
          const bytes=Buffer.from(result.data,'base64')
          res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store',
            'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(result.name.toWellFormed()).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))})
          res.end(bytes);return
        }
      }
      json(res,200,result)
      if(method!=='GET'){
        if(path==='/chat/cancel')chat.abort(result.jobId)
        chat.revalidate()
        coordination.revalidate()
        if(b.action==='inspect'&&/^\/runs\/[^/]+\/recovery$/.test(path))nodes.inspect(result.runId)
        else nodes.flush()
        broadcast();if(opts.chat!==false)void chat.tick()
      }
    }catch(e:any){if(!e.status)console.error(e);if(!res.headersSent)json(res,e.status??500,{error:e.status?e.message:'服务端处理失败',current:e.current});else res.end()}
  })
  const nodes=attachNodes(server,db,auth.node)
  function mustProject(projectId:unknown){
    if(typeof projectId!=='string'||!one(db,'SELECT 1 FROM projects WHERE id=?',projectId))fail('项目不存在',404)
  }
  function broadcast(){for(const [res,after] of streams){
    if(res.writableNeedDrain)continue
    const events=db.prepare('SELECT * FROM events WHERE cursor>? ORDER BY cursor LIMIT 200').all(after)
    for(const e of events){const value={...JSON.parse(String(e.body)),kind:e.kind,cursor:e.cursor};const ok=res.write('id: '+e.cursor+'\ndata: '+JSON.stringify(value)+'\n\n');streams.set(res,Number(e.cursor));if(!ok)break}
  }}
  const interval=setInterval(()=>{
    nodes.flush();chat.revalidate();coordination.revalidate();expireApprovals(db);dueReminders(db,opts.desktop?.notify);broadcast()
    if(opts.chat!==false){void chat.tick();void coordination.tick()}
  },500)
  const heartbeat=setInterval(()=>{for(const r of streams.keys())if(!r.writableNeedDrain)r.write(': heartbeat\n\n')},15000)
  server.on('close',()=>{clearInterval(interval);clearInterval(heartbeat)})
  const port=opts.port??Number(process.env.PORT??4317),host=opts.host??process.env.HOST??'127.0.0.1'
  server.listen(port,host)
  return {server,db,auth,ticket,dataDir,async close(){
    clearInterval(interval);clearInterval(heartbeat);nodes.close();chat.abort();coordination.abort()
    for(const r of streams.keys())r.end()
    await new Promise<void>((done)=>server.close(()=>done()))
    db.close()
  }}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const app=startServer()
  app.server.once('listening',()=>{const a=app.server.address() as any;console.log('小毛球工作台 http://'+(a.address.includes(':')?'['+a.address+']':a.address)+':'+a.port+'/login?ticket='+app.ticket);console.log('数据目录 '+app.dataDir)})
}
