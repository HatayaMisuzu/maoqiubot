import type { DatabaseSync } from 'node:sqlite'
import { fail, must, one, owner, required, unpack, changed } from '../db/index.ts'
import { getTask, taskView, taskCommunications, delegate, control, reconcileRun, sendInput, getThread,
  nativeSessionCatalogTarget,importNativeSession,selectModel } from '../tasks/index.ts'
import { homeApi } from '../home/index.ts'
import type { Principal } from '../home/common.ts'
import type { ChatToolDefinition } from './provider.ts'
import { readLocal, writeLocal } from './model-settings.ts'
import type { ModelConfig } from './model-settings.ts'
import { allowedRoot, localFiles, workspaceDirectory } from './files.ts'
import type { ToolEntry, RegisteredTool } from '../plugins/registry.ts'
import { parseTool, toolEntry } from '../plugins/registry.ts'
import { readText,relativePath } from '../plugins/files.ts'
import type { PluginHost } from '../plugins/host.ts'
import type { NativeHistory,NativeSession,NativeUsage } from '../../contracts/node.ts'
import { calculate,dailyAction } from './daily.ts'
import { projectWorkspaces } from '../tasks/workspaces.ts'
import { listBots, routingBots,tasksForThread } from '../tasks/bots.ts'
import { basename } from 'node:path'
import { offerMemory,saveUserMemory } from './memory.ts'
import { checkDelivery } from './delivery.ts'
import { createThread } from '../tasks/index.ts'
import { historySearch,historyRead,shareThread,nativeLifecycle } from '../sessions.ts'
import { continueBudget } from './budget.ts'
import type { HistorySource } from './budget.ts'

export type DesktopBridge={
  status():unknown; restart():Promise<unknown>; save(settings:unknown):unknown;
  worktreeSource?(instance:{id:string;workspaceRef:string;adapterKey:string}):string|undefined;
  openPath(path:string):Promise<string>; notify?(body:string):void;
}
export type ToolServices={desktop?:DesktopBridge;listSessions?(inst:any,cursor:string|null,projectId:string|null):Promise<{items:NativeSession[];nextCursor:string|null}>;
  readUsage?(instanceId:string):Promise<NativeUsage>;
  readNativeHistory?(thread:any,before?:string):Promise<NativeHistory>}

type Policy={task:boolean;memory:boolean;homeContent:boolean;homeSpace:boolean;personalInProject:boolean;readRoots:string[];writeRoots:string[];
  pluginCreator?:boolean;desktop?:boolean;memoryCandidates?:boolean;routineWrites?:boolean;routineRouting?:boolean;projectDirectories?:boolean;toolBudget?:number;toolHardLimit?:number}
const policyFile='chat-policy.json'
export const chatPolicy=(dir:string)=>readLocal<Policy>(dir,policyFile,{
  task:true,memory:true,homeContent:false,homeSpace:false,personalInProject:false,readRoots:[],writeRoots:[]
})
export function saveChatPolicy(dir:string,b:any){
  const p=chatPolicy(dir)
  for(const key of ['task','memory','homeContent','homeSpace','personalInProject','pluginCreator','desktop','memoryCandidates','routineWrites','routineRouting','projectDirectories'] as const){
    if(b[key]===undefined)continue
    if(typeof b[key]!=='boolean')fail('工具授权须为布尔值')
    p[key]=b[key]
  }
  for(const key of ['readRoots','writeRoots'] as const){
    if(b[key]===undefined)continue
    if(!Array.isArray(b[key])||b[key].length>10)fail('每组最多配置十个资料目录')
    p[key]=[...new Set<string>(b[key].map((v:unknown)=>allowedRoot(required(v,'资料目录'),dir)))]
  }
  for(const [key,min,max] of [['toolBudget',5,100],['toolHardLimit',10,100]] as const){
    if(b[key]===undefined)continue
    if(!Number.isSafeInteger(b[key])||b[key]<min||b[key]>max)fail(key+' 须为 '+min+' 到 '+max+' 的整数')
    p[key]=b[key]
  }
  if((p.toolBudget??10)>(p.toolHardLimit??100))fail('软工具预算不能高于硬上限')
  writeLocal(dir,policyFile,p)
  return p
}
export type Core={db:DatabaseSync;dir:string;thread:any;current:any;model?:Pick<ModelConfig,'shareProject'|'sharePersonal'|'shareAttachments'>;
  allowedInstances:any[];materials:any[];attachmentIds:string[];signal:AbortSignal;actor:'user'|'work_bot'|'system';
  historyVersions?:Map<string,HistorySource>;
  coordination?:{taskId:string;runId:string};
  plugins?:PluginHost;webDestinations?:Set<string>;webSources?:Map<string,{url:string;title:string;retrievedAt:string;body?:string}>}
  & ToolServices
const projectRouteTools=new Set(['bot_list','bot_get','bot_sessions','bot_native_catalog','bot_native_import','bot_open_topic','bot_history','bot_fork_session',
  'task_list','task_progress','task_communications','task_check_delivery','task_delegate','task_control','bot_send_message'])
type Shape='string'|'integer'|'array'|'boolean'|'object'
type Tool=ToolEntry<Core>&{
  group?:keyof Pick<Policy,'task'|'memory'|'homeContent'|'homeSpace'|'desktop'>;
  project?:boolean;file?:'read'|'write';
  public?:boolean; creator?:boolean;
}
function define(name:string,description:string,shape:Record<string,Shape>,required:string[],opts:Omit<Tool,keyof ChatToolDefinition>):Tool{
  if(projectRouteTools.has(name))shape={...shape,projectId:'string'}
  const parameters={type:'object',properties:Object.fromEntries(Object.entries(shape).map(([k,type])=>[k,{type,
    ...(type==='array'?{items:{},maxItems:30}:{})}])),required,additionalProperties:false}
  return {name,description,parameters,...opts}
}
function home(c:Core,method:string,path:string,body:object={},query:Record<string,string>={},asOwner=false){
  const project=c.thread.projectId
  const principal:Principal=asOwner||!project?owner:{id:'main',owner:false,projects:[project]}
  const result=homeApi(c.db,{method,path,body,dataDir:c.dir,principal,query:new URLSearchParams(query)})
  if(result===undefined)fail('资料工具接口不存在',404)
  if(method!=='GET'&&(!('mode' in body)||body.mode!=='preview'))changed(c.db,'home',{path,projectId:project})
  return result
}
const trail=(c:Core)=>({threadId:c.thread.id,messageId:c.current.id})
function scopedTask(c:Core,id:string){
  if(c.coordination&&c.coordination.taskId!==id)fail('协调只允许检查当前任务',403)
  const task=getTask(c.db,id)
  if(task.projectId!==c.thread.projectId||!task.projectId&&!tasksForThread(c.db,c.thread.id).some((item:any)=>item.id===task.id))
    fail('任务不在当前话题或项目范围内',403)
  return task
}
function progress(c:Core,id:string){
  const task=scopedTask(c,id),{run,commands,review}=taskView(c.db,task.id)
  const updates=c.db.prepare(`SELECT id,kind,text,createdAt FROM messages WHERE threadId=? AND role<>'user' AND text<>''
    AND (? IS NULL OR json_extract(data,'$.runId')=? OR kind='review') ORDER BY rowid DESC LIMIT 8`)
    .all(task.workThreadId,run?.id??null,run?.id??null).map(v=>({...v,text:String(v.text).slice(0,500)}))
  return {task:{id:task.id,goal:task.goal,status:task.status,workThreadId:task.workThreadId,instanceId:task.instanceId},
    run,commands:commands.slice(-12).map(({id,kind,status,detail}:any)=>({id,kind,status,detail})),updates,review}
}
function recordForScope(c:Core,id:string,asOwner=false){
  const record=home(c,'GET','/records/'+encodeURIComponent(id),{}, {},asOwner)
  if(record.projectId!==c.thread.projectId)fail('记录不在当前范围内',403)
  return record
}
const scopeQuery=(c:Core):Record<string,string>=>c.thread.projectId?{projectId:c.thread.projectId}:{scope:'personal'}
const idPath=(v:unknown)=>encodeURIComponent(required(v,'标识'))
const tools=[
  define('home_project_directory','把授权根目录下的现有目录登记为逻辑项目；明确要求全新软件时可新建子目录。返回实际可复用实例。',{
    name:'string',directory:'string',root:'integer',createDirectory:'boolean'},['name','directory','root'],{
    group:'homeContent',confirm:true,allowed:c=>!c.thread.projectId&&c.actor==='user'&&(!c.model||c.model.shareProject&&c.model.shareAttachments),
    execute:(c,a)=>{
      const p=chatPolicy(c.dir),create=a.createDirectory===true
      if(create&&!p.projectDirectories)fail('尚未授权新建项目目录',403)
      const root=(create?p.writeRoots:p.readRoots)[a.root]
      if(!root)fail('资料目录不在授权范围',403)
      const name=required(a.name,'项目名称')
      const base=allowedRoot(root,c.dir),directory=required(a.directory,'子目录')
      const existing=one(c.db,'SELECT id,binding FROM projects WHERE name=?',name)
      // Validate against an existing project before creating anything on disk.
      if(existing){
        const verified=workspaceDirectory(base,directory,false)
        const binding=JSON.parse(existing.binding??'null')
        if(binding?.localDirectory!==verified.path)fail('已有同名项目，请核对其目录',409)
        return {projectId:existing.id,workspaceRef:verified.path,created:false}
      }
      const ws=workspaceDirectory(base,directory,create)
      const mapped=one(c.db,`SELECT p.id FROM projects p WHERE json_extract(p.binding,'$.localDirectory')=?
        OR EXISTS(SELECT 1 FROM project_workspaces w JOIN instances i ON i.id=w.instanceId
        WHERE w.projectId=p.id AND i.nodeId='local' AND i.workspaceRef=?) LIMIT 1`,ws.path,ws.path)
      const project=mapped??home(c,'POST','/projects',{name,binding:{localDirectory:ws.path,nodeId:'local'}},{},true)
      const candidates=listBots(c.db).filter(bot=>bot.nodeId==='local'&&bot.workspaceRef===ws.path&&bot.settings.enabled&&bot.settings.allowDelegate&&
        (!bot.settings.allowedProjects||bot.settings.allowedProjects.includes(project.id))).map(bot=>bot.id)
      return {projectId:project.id,workspaceRef:ws.path,directoryCreated:ws.created,registeredInstances:candidates}
    }}),
  define('home_workspace_register','把已登记实例的现有工作区关联到项目，复用原目录。只建立路由映射。',{projectId:'string',instanceId:'string',workspaceRef:'string'},['projectId','instanceId','workspaceRef'],{
    group:'task',confirm:true,allowed:c=>c.actor==='user'&&(!c.model||c.model.shareProject),execute:(c,a)=>{
      const projectId=required(a.projectId,'项目')
      if(c.thread.projectId&&c.thread.projectId!==projectId)fail('无法修改其他项目的映射',403)
      const bot=listBots(c.db).find(b=>b.id===a.instanceId)
      if(!bot?.settings.enabled||!bot.settings.allowDelegate||bot.workspaceRef!==a.workspaceRef||
        bot.settings.allowedProjects&&!bot.settings.allowedProjects.includes(projectId))fail('实例不在此项目可映射范围',403)
      const existing=one(c.db,'SELECT 1 FROM project_workspaces WHERE projectId=? AND instanceId=?',projectId,bot.id)
      return projectWorkspaces(c.db,projectId,existing?'GET':'POST',{instanceId:bot.id,workspaceRef:bot.workspaceRef})
    }}),
  define('home_project_find','搜索已有项目及其已登记的 Bot 工作区。可按项目名或工作区片段查找；优先在已有项目继续。',{query:'string'},[],{
    group:'task',allowed:c=>c.actor==='user'&&(!c.model||c.model.shareProject),execute:(c,a)=>{
      const q=String(a.query??'').trim()
      return c.db.prepare(`SELECT DISTINCT p.id,p.name FROM projects p LEFT JOIN project_workspaces w ON w.projectId=p.id
        LEFT JOIN instances i ON i.id=w.instanceId WHERE (? IS NULL OR p.id=?)
        AND (instr(lower(p.name),lower(?))>0 OR instr(lower(i.workspaceRef),lower(?))>0)
        ORDER BY p.name,p.id LIMIT 60`).all(c.thread.projectId,c.thread.projectId,q,q).map(p=>({...p,bots:routingBots(c.db,String(p.id))}))
    }}),
  define('bot_workspace_discover','查询已配置实例的真实工作目录、节点、profile 与映射的项目。不会创建目录或执行原生命令。',{query:'string'},[],{
    group:'task',allowed:c=>c.actor==='user'&&(!c.model||c.model.shareProject),execute:(c,a)=>{
      const q=String(a.query??'').trim().toLowerCase()
      const bots=c.thread.projectId?routingBots(c.db,c.thread.projectId):listBots(c.db).filter(b=>b.settings.enabled&&b.settings.allowDelegate)
      return bots.filter(b=>b.workspaceRef&&[b.name,b.workspaceRef,b.id].some(x=>String(x).toLowerCase().includes(q)))
        .slice(0,60).map(b=>({instanceId:b.id,nodeId:b.nodeId,workspaceRef:b.workspaceRef,profileId:b.profileId,
          projects:c.db.prepare('SELECT p.id,p.name FROM projects p JOIN project_workspaces w ON w.projectId=p.id WHERE w.instanceId=? AND (? IS NULL OR p.id=?)')
            .all(b.id,c.thread.projectId,c.thread.projectId)}))
    }}),
  define('bot_list','查看本话题可用工作 Bot 的当前在线和能力',{},[],{execute:c=>c.allowedInstances}),
  define('bot_get','查看一个已注册工作 Bot 的能力、工作区与连接状态',{instanceId:'string'},['instanceId'],{execute:(c,a)=>{
    if(!c.allowedInstances.some(i=>i.id===a.instanceId))fail('实例不在当前授权范围',403)
    const bot=c.allowedInstances.find(i=>i.id===a.instanceId)
    const raw=must(c.db,'SELECT capabilities FROM instances WHERE id=?',a.instanceId)
    return {...bot,capabilities:JSON.parse(raw.capabilities||'{}')}
  }}),
  define('bot_usage','按需查询当前范围内工作 Bot 的官方额度窗口及更新时间。不可用时返回未知。',{instanceId:'string'},['instanceId'],{
    async:true,execute:async(c,a)=>{
      botAllowed(c,a.instanceId)
      const usage=await c.readUsage?.(a.instanceId)
      botAllowed(c,a.instanceId)
      return usage??{source:null,fetchedAt:null,windows:[]}
    }}),
  define('bot_sessions','按最近活动列出本范围的工作话题，可按名称片段查找或分页',{instanceId:'string',query:'string',offset:'integer'},['instanceId'],{execute:(c,a)=>{
    if(!c.allowedInstances.some(i=>i.id===a.instanceId))fail('实例不在当前授权范围',403)
    return c.db.prepare(`SELECT id AS threadId,title,sessionId,taskId,createdAt,lastActivity,source,state,
      (SELECT status FROM runs r WHERE r.threadId=t.id ORDER BY r.rowid DESC LIMIT 1) AS latestRunStatus
      FROM threads t WHERE instanceId=? AND projectId IS ? AND state IN ('active','archived') AND instr(lower(COALESCE(title,'')),lower(?))>0
      AND NOT EXISTS(SELECT 1 FROM task_drafts d WHERE d.threadId=t.id)
      ORDER BY lastActivity DESC,id LIMIT 25 OFFSET ?`).all(a.instanceId,c.thread.projectId,String(a.query??''),Math.max(0,a.offset??0))
  }}),
  define('bot_native_catalog','读取当前工作区连接器实际提供的原生会话目录',{instanceId:'string',cursor:'string'},['instanceId'],{
    async:true,execute:(c,a)=>{
      botAllowed(c,a.instanceId)
      if(!c.listSessions)fail('原生连接器不可用',409)
      if(a.cursor?.length>2000)fail('原生会话游标无效')
      return c.listSessions(nativeSessionCatalogTarget(c.db,a.instanceId,c.thread.projectId),a.cursor??null,c.thread.projectId)
    }}),
  define('bot_native_import','导入核对过的原生会话以便后续续接',{instanceId:'string',sessionId:'string',title:'string'},['instanceId','sessionId'],{
    group:'task',confirm:true,execute:(c,a)=>{
      botAllowed(c,a.instanceId)
      return importNativeSession(c.db,c.dir,a.instanceId,{...a,projectId:c.thread.projectId})
    }}),
  define('bot_thread_model','选择当前工作话题下一轮使用的原生模型',{threadId:'string',modelId:'string'},['threadId','modelId'],{
    group:'task',confirm:true,execute:(c,a)=>selectModel(c.db,workThread(c,a.threadId),a.modelId)}),
  define('bot_workspaces','查看、绑定或解除当前项目的执行工作区及资料授权',{
    action:'string',instanceId:'string',workspaceRef:'string',allowAgentAccess:'boolean',agentPermission:'string'},['action'],{
      group:'task',project:true,confirm:a=>a.action!=='list',execute:(c,a)=>{
        const method=({list:'GET',bind:'POST',unbind:'DELETE'} as Record<string,string>)[a.action]
        if(!['GET','POST','DELETE'].includes(method))fail('工作区操作无效')
        return projectWorkspaces(c.db,c.thread.projectId,method,a)
      }}),
  define('bot_desktop_status','查看桌面管理的连接器及工作 Bot 配置',{},[],{
    group:'desktop',allowed:c=>!c.thread.projectId,execute:c=>desktop(c).status()}),
  define('bot_desktop_save','在桌面保存经过校验的 Codex 或 DSH 实例配置',{settings:'object'},['settings'],{
    group:'desktop',allowed:c=>!c.thread.projectId,confirm:true,execute:(c,a)=>desktop(c).save(a.settings)}),
  define('bot_desktop_reconnect','重启本机连接器以载入设置。存在在途运行时由桌面服务拒绝。',{},[],{
    group:'desktop',allowed:c=>!c.thread.projectId,confirm:true,async:true,execute:c=>desktop(c).restart()}),
  define('bot_open_topic','查找当前范围内可打开的工作话题',{threadId:'string'},['threadId'],{
    execute:(c,a)=>{const thread=workThread(c,a.threadId);return {workThreadId:thread.id,title:thread.title}}
  }),
  define('bot_history','只读读取当前授权范围内绑定原生会话的历史。返回原生用户与 Bot 消息，不包含工作台内部交接提示',{threadId:'string',before:'string'},['threadId'],{
    group:'task',async:true,execute:async(c,a)=>{
      if(c.model?.shareAttachments===false)fail('当前模型未获准读取可能包含附件内容的原生历史',403)
      if(!c.readNativeHistory)fail('原生历史读取服务不可用',409)
      const thread=workThread(c,a.threadId)
      const page=await c.readNativeHistory(thread,a.before)
      const privatePrompts=new Set<string>(c.db.prepare(`SELECT text FROM messages WHERE threadId=? AND kind IN ('brief','communication')
        AND json_extract(data,'$.communication.visibility')='bot_internal'`).all(thread.id).map((row:any)=>String(row.text)))
      const privatePath=/(?:[A-Za-z]:\\|\/)(?:[^\s"'<>]+[\\/])*(?:\.env(?:\.[^\s"'<>]+)?|\.credentials(?:\.[^\s"'<>]+)?|chat-model-keys\.json|[^\s"'<>]*(?:secret|credential|token|api[-_]?key|password)[^\s"'<>]*)(?:[^\s"'<>]*)/giu
      const visible=page.items.filter(item=>!item.text.startsWith('工作台通信 ')&&!item.text.includes('本次运行拥有项目 ')&&
        !item.text.includes('向小毛球报告：node ')&&![...privatePrompts].some(prompt=>prompt&&item.text.includes(prompt)))
      const latestAssistant=new Set(visible.filter(item=>item.role==='assistant').slice(-8).map(item=>item.id))
      const items=visible.filter(item=>item.role!=='assistant'||latestAssistant.has(item.id))
        .map(item=>({...item,text:item.text.replace(privatePath,'[本机凭据路径已隐藏]')}))
      return {threadId:thread.id,scope:'当前项目原生会话',source:'连接器只读历史',items,nextBefore:page.nextBefore}
    }}),
  define('bot_fork_session','在指定原生会话分支，创建独立原生会话并返回排队回执',{threadId:'string',title:'string'},['threadId'],{
    group:'task',execute:(c,a)=>{
      const thread=workThread(c,a.threadId)
      return nativeLifecycle(c.db,c.dir,thread,'fork',a.title,'main_bot')
    }}),
  define('history_search','在当前项目或个人范围内搜索小毛球主聊和侧聊历史',{query:'string',limit:'integer'},['query'],{
    execute:(c,a)=>{
      if(c.thread.projectId&&chatPolicy(c.dir).personalInProject&&c.model&&!c.model.sharePersonal)
        fail('当前模型未获准读取包含个人资料的项目聊天历史',403)
      const result=historySearch(c.db,c.thread,c.model,a)
      for(const id of new Set(result.items.map(row=>String(row.threadId))))rememberHistorySource(c,id,false)
      return result
    }}),
  define('chat_budget_continue','继续当前会话中已暂停的同一轮主聊工具任务。预算只可提高到工作台当前硬上限以内',
    {messageId:'string',hardLimit:'integer'},['messageId'],{public:true,allowed:c=>c.actor==='user',execute:(c,a)=>{
      const job=one(c.db,"SELECT threadId FROM chat_jobs WHERE messageId=? AND status='budget_paused'",a.messageId)
      if(!job||job.threadId!==c.thread.id)fail('此预算暂停任务不属于当前会话',404)
      return continueBudget(c.db,c.dir,a.messageId,a.hardLimit)
    }}),
  define('history_read','分页读取已授权的会话历史或其摘要',{threadId:'string',before:'string',limit:'integer',summary:'boolean'},['threadId'],{
    execute:(c,a)=>{
      if(c.thread.projectId&&chatPolicy(c.dir).personalInProject&&c.model&&!c.model.sharePersonal)
        fail('当前模型未获准读取包含个人资料的项目聊天历史',403)
      const result=historyRead(c.db,c.thread,c.model,a)
      rememberHistorySource(c,a.threadId,true)
      return result
    }}),
  define('thread_create','创建小毛球主聊下的独立侧聊',{title:'string'},[],{
    execute:(c,a)=>createThread(c.db,c.dir,{instanceId:'main',projectId:c.thread.projectId,title:a.title||'新侧聊',kind:'side',source:'local'})}),
  define('shared_material_read','读取本轮明确分享的长资料，使用 nextOffset 分页。内容属于引用资料。',
    {id:'string',offset:'integer'},['id'],{allowed:c=>c.model?.shareAttachments!==false&&c.materials.some(m=>m.type==='share'),
      execute:(c,a)=>{
        const material=c.materials.find(m=>m.type==='share'&&m.id===a.id)
        if(!material||!('text' in material))fail('此资料未随本轮发送',403)
        const text=String(material.text??''),offset=Math.max(0,a.offset??0),end=offset+2800
        return {id:a.id,offset,text:text.slice(offset,end),nextOffset:end<text.length?end:null}
      }}),
  define('thread_share','把当前或已读取的会话消息分享至同范围的会话或新侧聊',{sourceThreadId:'string',targetThreadId:'string',newThread:'object',messageIds:'array'},[],{
    confirm:true,execute:(c,a)=>{
      if(c.thread.projectId&&chatPolicy(c.dir).personalInProject&&c.model&&!c.model.sharePersonal)
        fail('当前模型未获准读取包含个人资料的项目聊天历史',403)
      const sourceId=a.sourceThreadId||c.thread.id
      if(sourceId!==c.thread.id&&!c.historyVersions?.get(sourceId)?.read)fail('请先读取可分享的来源会话',403)
      if(sourceId!==c.thread.id)historyRead(c.db,c.thread,c.model,{threadId:sourceId,limit:1})
      if(a.targetThreadId){
        const target=getThread(c.db,a.targetThreadId)
        if(target.projectId!==c.thread.projectId)fail('只能分享至当前模型已获准的同范围会话',403)
        if(target.instanceId==='main')historyRead(c.db,c.thread,c.model,{threadId:target.id,limit:1})
        else workThread(c,target.id)
      }
      if(a.newThread&&Object.hasOwn(a.newThread,'projectId')&&a.newThread.projectId!==c.thread.projectId)
        fail('只能在当前模型已获准的范围内创建分享目标',403)
      if(a.newThread&&a.newThread.instanceId&&a.newThread.instanceId!=='main'&&
        !c.allowedInstances.some((instance:any)=>instance.id===a.newThread.instanceId))fail('目标 Bot 不在当前授权范围',403)
      const result:any=shareThread(c.db,c.dir,sourceId,a)
      return {shareId:result.shareId,targetThreadId:result.targetThreadId,count:result.items.length}
    }}),
  define('task_list','列出当前项目或话题的工作任务',{},[],{execute:c=>{
    const linked=tasksForThread(c.db,c.thread.id).filter((task:any)=>task.projectId===c.thread.projectId)
    const scoped=c.thread.projectId?c.db.prepare('SELECT * FROM tasks WHERE projectId=? ORDER BY rowid DESC LIMIT 100').all(c.thread.projectId):linked
    const all=new Map<string,any>()
    for(const task of [...scoped,...linked] as any[])all.set(String(task.id),task)
    return [...all.values()].sort((a,b)=>String(b.createdAt??'').localeCompare(String(a.createdAt??''))).slice(0,30)
      .map(({id,goal,instanceId,status,workThreadId}:any)=>({id,goal,instanceId,status,workThreadId}))
  }}),
  define('task_progress','读取某个任务的真实运行、动作回执、最近消息与验收',{taskId:'string'},['taskId'],{execute:(c,a)=>progress(c,a.taskId)}),
  define('task_communications','读取当前任务的澄清、回复、交接和交付消息',{taskId:'string'},['taskId'],
    {execute:(c,a)=>{scopedTask(c,a.taskId);return taskCommunications(c.db,a.taskId)}}),
  define('task_check_delivery','检查当前任务的实际运行回执、交付引用及获准读取的本机成果，列出待核对项。',
    {taskId:'string',includeExcerpt:'boolean'},['taskId'],{execute:(c,a)=>{
      const task=scopedTask(c,a.taskId)
      const mayRead=!c.model||c.model.shareAttachments
      return checkDelivery(c.db,c.dir,task,c.coordination?.runId,mayRead?chatPolicy(c.dir).readRoots:[],mayRead&&a.includeExcerpt===true)
    }}),
  define('task_coordination_status','检查任务协调方式、暂停状态、获准转交对象和近期协调结果。',{taskId:'string'},['taskId'],{execute:(c,a)=>{
    const task=scopedTask(c,a.taskId)
    return {taskId:task.id,scope:task.brief.coordination??null,events:c.db.prepare(`SELECT j.status,m.id,m.kind,m.createdAt,
      json_extract(m.data,'$.type') AS type FROM chat_jobs j JOIN messages m ON m.id=j.messageId
      WHERE j.kind='coordination' AND m.taskId=? ORDER BY j.id DESC LIMIT 12`).all(task.id)}
  }}),
  define('maintenance_status','检查当前范围内工作 Bot 掉线、运行待恢复、协调积压及扩展状态。',{},[],{
    allowed:c=>c.actor==='user',execute:c=>{
      const linked=tasksForThread(c.db,c.thread.id).filter((task:any)=>task.projectId===c.thread.projectId)
      const scoped=c.thread.projectId?c.db.prepare(`SELECT * FROM tasks WHERE projectId=?`).all(c.thread.projectId):linked
      const unique=new Map<string,any>([...scoped,...linked].map((task:any)=>[task.id,task]))
      const tasks=[...unique.values()].map((task:any)=>({id:task.id,instanceId:task.instanceId,status:task.status,workThreadId:task.workThreadId,
        runId:one(c.db,'SELECT id FROM runs WHERE threadId=? ORDER BY rowid DESC LIMIT 1',task.workThreadId)?.id??null,
        runStatus:one(c.db,'SELECT status FROM runs WHERE threadId=? ORDER BY rowid DESC LIMIT 1',task.workThreadId)?.status??null,
        held:one(c.db,"SELECT 1 FROM commands WHERE taskId=? AND status='held' LIMIT 1",task.id)?1:0}))
        .filter((task:any)=>['uncertain','waiting_input'].includes(task.runStatus)||task.held).slice(0,20)
      const coordination=c.db.prepare(`SELECT status,COUNT(*) AS count FROM chat_jobs
        WHERE threadId=? AND kind='coordination' AND status IN ('queued','working','failed') GROUP BY status`).all(c.thread.id)
      const extensions=c.plugins?.list().plugins.filter(p=>p.current&&(!p.current.projectId||p.current.projectId===c.thread.projectId))
        .map(({id,enabled,loaded,error})=>({id,enabled,loaded,hasError:!!error}))??[]
      return {offlineBots:c.allowedInstances.filter(i=>!i.online).map(({id,name})=>({id,name})),tasks,coordination,extensions}
    }}),
  define('task_delegate','创建工作任务。协调策略默认为 notify；仅用户明确要求时选择 assist 或 handoff，后者须指定 handoffTargets。',
    {instanceId:'string',goal:'string',workThreadId:'string',taskId:'string',routeReason:'string',constraints:'array',doneWhen:'array',refs:'array',coordination:'string',handoffTargets:'array'},['instanceId','goal'],
    {group:'task',confirm:true,execute:(c,a)=>{
      if(!c.allowedInstances.some(i=>i.id===a.instanceId))fail('实例不在当前授权范围',403)
      if(a.routeReason!==undefined&&(typeof a.routeReason!=='string'||a.routeReason.length>1000))fail('路由依据最多 1000 字符')
      if(a.taskId){
        const task=scopedTask(c,a.taskId)
        if(task.instanceId!==a.instanceId||a.workThreadId&&task.workThreadId!==a.workThreadId)
          fail('接续任务或工作话题与所选 Bot 不匹配',403)
      }else if(a.workThreadId){
        const work=workThread(c,a.workThreadId)
        if(work.instanceId!==a.instanceId)fail('工作话题不属于所选 Bot',403)
      }
      const refs=(a.refs??[]).map((v:any)=>({type:v?.type,id:v?.id}))
      return delegate(c.db,c.dir,{...a,originThreadId:c.thread.id,projectId:c.thread.projectId,attachmentIds:c.attachmentIds,
        refs:[...c.materials,...refs]},c.current.id)
    }}),
  define('task_control','补充、转达、停止或检查任务。原生权限确认由用户亲自作出',{taskId:'string',action:'string',text:'string',commandId:'string',replyTo:'string'},['taskId','action'],
    {group:'task',confirm:a=>a.action!=='inspect',execute:(c,a)=>{
      const task=scopedTask(c,a.taskId),{run}=taskView(c.db,task.id)
      if(!run)fail('任务没有可操作的运行')
      if(a.action==='inspect')return reconcileRun(c.db,run.id,{action:'inspect'})
      if(a.action==='message'){
        return sendInput(c.db,c.dir,getThread(c.db,task.workThreadId),{text:a.text,replyTo:a.replyTo,refs:c.materials,attachmentIds:c.attachmentIds},c.current.id)
      }
      if(!['steer','cancel','resume'].includes(a.action))fail('需要所有者直接操作该项运行控制',403)
      return control(c.db,c.dir,run.id,{kind:a.action,text:a.text,commandId:a.commandId,refs:c.materials,attachmentIds:c.attachmentIds},c.current.id)
    }}),
  define('home_search','按关键词查当前范围的来源、笔记、交接和记录',{query:'string',kind:'string'},['query'],
    {execute:(c,a)=>{
      if(c.model&&!c.model.shareAttachments&&a.kind==='source')fail('此模型未获授权读取原件资料',403)
      const kind=c.model&&!c.model.shareAttachments?'record':a.kind
      return home(c,'GET','/search',{}, {...scopeQuery(c),q:a.query,limit:'20',...(kind?{kind}:{})})
    }}),
  define('home_get','读取当前项目简报、记录、已授权来源、附件元数据或空间',{kind:'string',id:'string'},['kind'],
    {execute:(c,a)=>{
      const project=c.thread.projectId
      if(a.kind==='record')return recordForScope(c,a.id)
      if(a.kind==='brief'&&project){
        const {project:meta,requirements,decisions,latestWork,openItems,pendingVerification}=home(c,'GET','/projects/'+idPath(project)+'/brief')
        return {project:meta,requirements:requirements.slice(0,12),decisions:decisions.slice(0,12),latestWork:latestWork.slice(0,12),openItems,pendingVerification}
      }
      if(a.kind==='space'&&project){
        const p=home(c,'GET','/projects/'+idPath(project))
        if(a.id&&a.id!==p.spaceId)fail('只能读取当前项目的空间',403)
        return home(c,'GET','/spaces/'+idPath(p.spaceId))
      }
      if(['source','attachment'].includes(a.kind)){
        if(c.model&&!c.model.shareAttachments)fail('此模型未获授权读取原件资料',403)
        const original=home(c,'GET','/'+a.kind+'s/'+idPath(a.id),{},project?{projectId:project,meta:'1'}:{meta:'1'})
        if(!project&&(original.projectIds?.length||original.endpointIds?.length))fail('资料不在个人范围内',403)
        return a.kind==='source'?{...original,text:original.text.slice(0,9000),localRef:undefined}:original
      }
      fail('资料类型或范围不支持')
    }}),
  define('home_project_create','使用用户本轮明确指定的名称创建项目及默认空间',{name:'string'},['name'],
    {group:'homeContent',confirm:true,execute:(c,a)=>{
      if(c.thread.projectId||!a.name.trim()||!c.current.text.includes(a.name.trim()))fail('请在个人主聊明确指定新项目名称',403)
      if(one(c.db,'SELECT id FROM projects WHERE name=? LIMIT 1',a.name.trim()))fail('同名项目已存在，请先检查',409)
      return home(c,'POST','/projects',{name:a.name.trim()},{},true)
    }}),
  define('home_record_save','在当前项目保存记录、待办或交接',{type:'string',body:'string',refs:'array',sourceId:'string',remaining:'array',version:'string'},['type','body'],
    {group:'homeContent',confirm:true,project:true,execute:(c,a)=>{
      if(!['note','decision','requirement','handoff','todo'].includes(a.type))fail('该记录类型需所有者直接操作')
      return home(c,'POST','/projects/'+idPath(c.thread.projectId)+'/records',{type:a.type,body:a.body,refs:a.refs,sourceId:a.sourceId,
        author:'小毛球',extra:{...trail(c),remaining:a.remaining,version:a.version}})
    }}),
  define('home_record_update','修订当前项目的一条普通记录，保留原版本',{id:'string',expectedRevision:'integer',body:'string'},['id','expectedRevision','body'],
    {group:'homeContent',confirm:true,project:true,execute:(c,a)=>{
      recordForScope(c,a.id)
      return home(c,'PATCH','/records/'+idPath(a.id),{expectedRevision:a.expectedRevision,body:a.body})
    }}),
  define('home_collection_entries','查看当前项目集合条目，或按本轮指令新增、更新条目',{id:'string',action:'string',entryId:'string',
    expectedRevision:'integer',values:'object'},['id','action'],{project:true,confirm:a=>a.action!=='list',execute:(c,a)=>{
      const {id:projectId,spaceId}=home(c,'GET','/projects/'+idPath(c.thread.projectId))
      if(!one(c.db,'SELECT 1 FROM space_collections WHERE id=? AND space_id=?',a.id,spaceId)||projectId!==c.thread.projectId)
        fail('集合不在当前项目默认空间',403)
      const path='/collections/'+idPath(a.id)+'/entries'
      if(a.action==='list'){
        const result=home(c,'GET',path)
        return {...result,items:result.items.slice(0,25)}
      }
      if(!chatPolicy(c.dir).homeContent)fail('当前未授权修改集合内容',403)
      if(a.action==='create')return home(c,'POST',path,{values:a.values})
      if(a.action==='update')return home(c,'PATCH',path+'/'+idPath(a.entryId),{expectedRevision:a.expectedRevision,values:a.values})
      fail('集合操作无效')
    }}),
  define('home_space_change','预览或应用当前项目的页面、集合和布局操作',{mode:'string',expectedRevision:'integer',operations:'array'},['mode','expectedRevision','operations'],
    {group:'homeSpace',confirm:a=>a.mode==='apply',project:true,execute:(c,a)=>{
      if(!['preview','apply'].includes(a.mode)||!a.operations.length||a.operations.length>12)fail('空间操作数量或模式无效')
      const benign=['setSpace','createPage','updatePage','movePage','addBlock','updateBlock','moveBlock','createCollection','updateCollection','addField','toggleModule']
      if(a.operations.some((op:any)=>!benign.includes(op?.op)))fail('删除、恢复、字段转换等操作请通过空间编辑器核对后执行',403)
      const p=home(c,'GET','/projects/'+idPath(c.thread.projectId))
      const endpoint='/spaces/'+idPath(p.spaceId)+'/changes'
      const preview=home(c,'POST',endpoint,{...a,mode:'preview'})
      return a.mode==='apply'?home(c,'POST',endpoint,a):preview
    }}),
  define('memory_search','查找当前项目或个人范围内的记忆',{query:'string'},['query'],{execute:(c,a)=>
    home(c,'GET','/search',{}, {...scopeQuery(c),q:a.query,kind:'record',limit:'20'})}),
  define('memory_get','读取一条当前范围的记忆及修订',{id:'string'},['id'],{execute:(c,a)=>{
    recordForScope(c,a.id)
    return home(c,'GET','/records/'+idPath(a.id),{},{history:'1'})
  }}),
  define('memory_save','保存用户明确要求记住的原话。body 必须是当前用户话语中的原文片段',{body:'string',factKey:'string',type:'string',important:'boolean',validUntil:'string'},['body'],
    {group:'memory',confirm:true,execute:(c,a)=>{
      if(!a.body.trim()||!c.current.text.includes(a.body.trim()))fail('确认的记忆须引用当前真实用户原话',403)
      const type=a.type??'preference'
      if(!['preference','note','decision','requirement'].includes(type))fail('无效记忆分类')
      return saveUserMemory(c.db,c.dir,c.thread,{...a,type,messageId:c.current.id})
    }}),
  define('memory_offer','仅当用户本轮表达稳定信息且允许记忆候选时提议保存，候选仍需人工审阅。',
    {body:'string',factKey:'string',type:'string',important:'boolean'},['body'],{
      group:'memory',allowed:c=>chatPolicy(c.dir).memoryCandidates===true&&c.actor==='user',
      execute:(c,a)=>offerMemory(c.db,c.thread,c.current,a)??{status:'skipped'}}),
  define('memory_update','以本轮用户明确指定的原文更新记忆，保留原修订',{id:'string',expectedRevision:'integer',body:'string'},['id','expectedRevision','body'],
    {group:'memory',confirm:true,execute:(c,a)=>{
      if(!a.body.trim()||!c.current.text.includes(a.body.trim()))fail('须明确说明要更新的记忆和新的原文',403)
      const saved=recordForScope(c,a.id)
      if(!['preference','note','decision','requirement'].includes(saved.type))fail('所选记录不属于记忆分类',403)
      return home(c,'PATCH','/records/'+idPath(a.id),{...a,confirmation:'user',extra:{...saved.extra,...trail(c)}},{},true)
    }}),
  define('memory_forget','遗忘用户明确指定的本范围记忆，保留原件',{id:'string',expectedRevision:'integer'},['id','expectedRevision'],
    {group:'memory',confirm:true,execute:(c,a)=>{
      const saved=recordForScope(c,a.id)
      if(!['preference','note','decision','requirement'].includes(saved.type))fail('所选记录不属于记忆分类',403)
      return home(c,'DELETE','/records/'+idPath(a.id),{expectedRevision:a.expectedRevision},{},true)
    }}),
  define('local_files_list','列出授权资料目录内的文本文件和子目录',{root:'integer',path:'string'},['root'],
    {file:'read',execute:(c,a)=>file(c,a,'list')}),
  define('local_files_read','读取授权目录内的小型文本资料',{root:'integer',path:'string'},['root','path'],
    {file:'read',execute:(c,a)=>file(c,a,'read')}),
  define('local_files_write','在写入许可的目录新建资料文本，不覆盖',{root:'integer',path:'string',body:'string'},['root','path','body'],
    {file:'write',confirm:true,execute:(c,a)=>file(c,a,'write')}),
  define('local_files_open','在桌面打开已授权的文件夹或普通文本',{root:'integer',path:'string'},['root'],{
    file:'read',group:'desktop',confirm:true,async:true,execute:async(c,a)=>{
      const d=desktop(c),found=file(c,a,'open')
      const error=await d.openPath(found.localPath!)
      if(error)fail('桌面系统无法打开目标文件',409)
      return {opened:true,path:a.path??''}
    }}),
  define('local_files_archive','把已授权文本归档成毛球之家附件和来源',{root:'integer',path:'string'},['root','path'],{
    file:'read',group:'homeContent',confirm:true,execute:(c,a)=>{
      const found=file(c,a,'archive'),name=basename(a.path)
      const attached=home(c,'POST','/attachments',{name,projectId:c.thread.projectId??undefined,contentType:'text/plain',
        data:Buffer.from(found.text!,'utf8').toString('base64')},{},true)
      const archived=home(c,'POST','/submissions',{projectId:c.thread.projectId??undefined,source:{title:name,text:found.text,
        author:'小毛球',platform:'本机附件',attachmentIds:[attached.id]}},{},true)
      return {id:attached.id,sourceId:archived.sourceId,size:attached.size}
    }}),
  define('utility_clock','查询工作台当前时间（含 UTC 和上海时区）',{},[],{execute:()=>({
    utc:new Date().toISOString(),shanghai:new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'medium',timeZone:'Asia/Shanghai'}).format(new Date())
  }),public:true}),
  define('utility_calculate','精确计算四则运算和括号内小数，返回小数及精确分数',{expression:'string'},['expression'],{
    public:true,execute:(_c,a)=>calculate(a.expression)}),
  define('utility_daily','查询、创建、修改或处理当前范围的待办和提醒。dueAt 使用含时区的 ISO 时间。',
    {action:'string',id:'string',kind:'string',body:'string',dueAt:'string',expectedRevision:'integer'},['action'],{
      confirm:a=>a.action!=='list',execute:(c,a)=>dailyAction(c.db,c.thread,a)}),
  define('skill_list','按当前意图搜索已启用的标准 Skill 及用途',{query:'string'},[],{
    public:true,allowed:c=>!c.model||(c.thread.projectId?c.model.shareProject:c.model.sharePersonal),execute:(c,a)=>{
      const q=String(a.query??'').trim().toLocaleLowerCase()
      if(q.length>500)fail('Skill 查询过长')
      const terms=[...new Set(q.split(/[^\p{L}\p{N}_-]+/u).filter(term=>term.length>1))]
      return (c.plugins?.skills(c.thread.projectId)??[]).filter(s=>!s.projectId||s.projectId===c.thread.projectId)
        .map(skill=>{
          const haystack=(skill.name+' '+skill.description).toLocaleLowerCase()
          const score=terms.reduce((sum,term)=>sum+(haystack.includes(term)?(haystack.includes(q)?4:1):0),0)
          return {skill,score}
        }).filter(item=>!terms.length||item.score>0).sort((a,b)=>b.score-a.score||a.skill.name.localeCompare(b.skill.name))
        .slice(0,30).map(({skill})=>{const {root,projectId,...meta}=skill;return meta})
    }}),
  define('skill_read','按 ID 读取 Skill 正文或 references/、assets/ 中的文本',{id:'string',path:'string'},['id'],{
    allowed:c=>c.actor==='user'&&(!c.model||(c.thread.projectId?c.model.shareProject:c.model.sharePersonal)),execute:(c,a)=>{
      const skill=c.plugins?.skills(c.thread.projectId).find(s=>s.id===a.id)
      if(!skill)fail('当前范围内没有该 Skill',404)
      const path=a.path??'SKILL.md'
      if(path!=='SKILL.md'&&!/^(references|assets)\//.test(path))fail('只能读取 Skill 正文、参考和文本资源',403)
      return {id:skill.id,version:skill.version,instructions:readText(skill.root,path,128000).slice(0,10000),trust:'external-data'}
    }}),
  define('plugin_list','查看当前扩展状态、版本和已注册能力',{},[],{creator:true,execute:c=>
    c.plugins?.list().plugins.filter(p=>[p.current,p.pending].some(pkg=>pkg&&(!pkg.projectId||pkg.projectId===c.thread.projectId)))
      .map(({id,loaded,tools,skills,providers,current,pending,error})=>({id,loaded,tools,skills,providers,error,
        version:current?.manifest.version,currentDigest:current?.digest,draftVersion:pending?.manifest.version,draftDigest:pending?.digest}))??[]}),
  define('plugin_scaffold','创建或更新待审查插件草稿。优先声明式清单或标准 Skill。代码草稿使用 index.mjs 的 activate(ctx)。',
    {manifest:'object',source:'string',files:'array',skillName:'string',skillText:'string'},['manifest'],{
      creator:true,confirm:true,async:true,execute:(c,a)=>{
        if(!c.plugins)fail('插件管理不可用',409)
        const files=new Map<string,Buffer>(),manifest={...a.manifest}
        if(a.source){manifest.entry='index.mjs';files.set('index.mjs',Buffer.from(a.source))}
        if(a.files!==undefined){
          if(!Array.isArray(a.files)||a.files.length>100)fail('插件文件最多 100 个')
          let total=0
          for(const item of a.files){
            if(!item||typeof item.path!=='string'||typeof item.content!=='string')fail('插件文件须包含相对路径和文本内容')
            const path=relativePath(item.path)
            const content=Buffer.from(item.content,'utf8')
            total+=content.length
            if(total>8*1024*1024||content.includes(0)||files.has(path))fail('插件文件超出大小、含二进制内容或路径重复')
            files.set(path,content)
          }
        }
        if(a.skillName||a.skillText){
          if(!a.skillName||!a.skillText||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.skillName))fail('须提供合规的 Skill 名称及正文')
          manifest.skills=['skills/'+a.skillName]
          files.set(manifest.skills[0]+'/SKILL.md',Buffer.from(a.skillText))
        }
        files.set('plugin.json',Buffer.from(JSON.stringify(manifest,null,2)))
        return c.plugins.stageDraft(files,c.signal,c.thread.projectId??undefined)
      }}),
  define('plugin_validate','静态检查草稿的清单、Schema、代码语法和 Skill。执行测试需审查后在授权环境进行。',
    {id:'string'},['id'],{creator:true,async:true,execute:(c,a)=>c.plugins?.validateDraft(a.id,c.thread.projectId)}),
  define('plugin_source_read','按版本和摘要读取插件中的指定源文件用于核查',{id:'string',version:'string',digest:'string',path:'string'},['id','version','digest','path'],{
    creator:true,async:true,execute:(c,a)=>{
      if(!['current','pending','previous'].includes(a.version))fail('请选择明确的插件版本')
      const plugin=c.plugins?.list().plugins.find(p=>p.id===a.id)
      const pkg=plugin&&({current:plugin.current,pending:plugin.pending,previous:plugin.previous} as any)[a.version]
      if(!pkg||((pkg.projectId??null)!==(c.thread.projectId??null)))fail('当前范围内没有该插件版本',404)
      return c.plugins!.manage({action:'source',id:a.id,version:a.version,digest:a.digest,path:a.path},c.signal)
    }}),
  define('plugin_revise','以已核对的 baseDigest 修改草稿，可在一次修订中更新、添加或移除多份文件',{id:'string',baseDigest:'string',files:'array',remove:'array',manifest:'object'},['id','baseDigest','files'],{
    creator:true,async:true,execute:(c,a)=>{
      const plugin=c.plugins?.list().plugins.find(p=>p.id===a.id)
      const pkg=plugin?.pending??plugin?.current
      if(!pkg||pkg.digest!==a.baseDigest||((pkg.projectId??null)!==(c.thread.projectId??null)))fail('基准版本不在当前范围或已改变',409)
      return c.plugins!.manage({action:'revise',id:a.id,baseDigest:a.baseDigest,files:a.files,remove:a.remove,manifest:a.manifest},c.signal)
    }}),
  define('plugin_review','查看插件待审查版本相对当前版本的差异、能力变化和版本摘要',{id:'string',version:'string'},['id'],{
    creator:true,async:true,execute:async(c,a)=>{
      const plugin=c.plugins?.list().plugins.find(p=>p.id===a.id)
      if(!plugin||((plugin.pending as any)?.projectId??null)!==(c.thread.projectId??null))fail('当前范围内没有该插件草稿',404)
      return c.plugins!.manage({action:'review',id:a.id,version:a.version},c.signal)
    }}),
  define('plugin_activate','启用已审查的插件版本。代码和网络能力仍需对应授权',{id:'string',digest:'string',trustCode:'boolean',allowNetwork:'boolean'},['id','digest'],{
    creator:true,confirm:true,async:true,execute:async(c,a)=>{
      const plugin=c.plugins?.list().plugins.find(p=>p.id===a.id)
      if(!plugin||((plugin.pending as any)?.projectId??(plugin.current as any)?.projectId??null)!==(c.thread.projectId??null))
        fail('当前范围内没有可启用的插件版本',404)
      return c.plugins!.manage({action:'activate',id:a.id,digest:a.digest,trustCode:a.trustCode===true,allowNetwork:a.allowNetwork===true},c.signal)
    }}),
  define('plugin_runtime_test','对已启用的插件运行其声明的连接测试并返回真实结果',{id:'string',input:'object'},['id','input'],{
    creator:true,confirm:true,async:true,execute:(c,a)=>{
      const plugin=c.plugins?.list().plugins.find(p=>p.id===a.id)
      if(!plugin?.current||!plugin.loaded||(plugin.current.projectId??null)!==c.thread.projectId)fail('此范围内没有运行中的插件',409)
      return c.plugins!.manage({action:'test',id:a.id,digest:plugin.current.digest,input:a.input},c.signal)
    }}),
  define('plugin_switch','停用插件或回滚到已审查的前一版本',{id:'string',action:'string',digest:'string',trustCode:'boolean',allowNetwork:'boolean'},['id','action','digest'],{
    creator:true,confirm:true,async:true,execute:(c,a)=>{
      if(!['disable','rollback'].includes(a.action))fail('请选择停用或回滚')
      const plugin=c.plugins?.list().plugins.find(p=>p.id===a.id)
      const version=a.action==='rollback'?plugin?.previous:plugin?.current
      if(!version||version.digest!==a.digest||(version.projectId??null)!==c.thread.projectId)fail('此范围内没有可操作的插件版本',409)
      return c.plugins!.manage({action:a.action,id:a.id,digest:a.digest,trustCode:a.trustCode===true,allowNetwork:a.allowNetwork===true},c.signal)
    }}),
  define('web_archive','把本轮实际读取的网页正文和来源归档至当前项目或个人资料',{id:'string'},['id'],{
    group:'homeContent',allowed:c=>c.plugins?.tools.has('web__read')===true,confirm:true,execute:(c,a)=>{
      const source=c.webSources?.get(a.id)
      if(!source?.body)fail('只可归档本轮实际读取的网页',403)
      return home(c,'POST','/submissions',{projectId:c.thread.projectId??undefined,
        source:{title:source.title,text:source.body,url:source.url,platform:'公开网页'},
        records:[{type:'note',body:source.title,author:'网页资料',confirmation:'unconfirmed',
          extra:{url:source.url,retrievedAt:source.retrievedAt,sourceType:'web'}}]}, {},true)
    }}),
]
function desktop(c:Core){
  if(!c.desktop)fail('此工作台没有桌面宿主',409)
  return c.desktop
}
function rememberHistorySource(c:Core,id:string,read:boolean){
  const source=getThread(c.db,id)
  const reset=one(c.db,'SELECT version FROM thread_context_resets WHERE threadId=?',source.id)
  c.historyVersions??=new Map()
  c.historyVersions.set(id,{contextRevision:Number(source.contextRevision??0),resetVersion:Number(reset?.version??0),
    state:source.state,read:read||c.historyVersions.get(id)?.read===true})
}
function botAllowed(c:Core,id:string){
  if(!c.allowedInstances.some(i=>i.id===id))fail('实例不在当前授权范围',403)
}
function workThread(c:Core,id:string){
  const thread=getThread(c.db,id)
  if(thread.instanceId==='main'||thread.projectId!==c.thread.projectId)fail('工作话题不在当前范围',403)
  botAllowed(c,thread.instanceId)
  return thread
}
function file(c:Core,a:any,operation:'list'|'read'|'write'|'open'|'archive'){
  const p=chatPolicy(c.dir),root=(operation==='write'?p.writeRoots:p.readRoots)[a.root]
  if(!root)fail('没有授权该资料目录',403)
  try{return localFiles(allowedRoot(root,c.dir),a.path??'',operation,a.body)}
  catch(e){if((e as {status?:number}).status)throw e;fail('本机文件不可用、不可读取或同名文件已存在',409)}
}
function enabled(c:Core,t:Tool,policy:Policy){
  return (!t.group||policy[t.group])&&(!t.project||c.thread.projectId)&&(!t.creator||policy.pluginCreator&&c.actor==='user')&&
    (!c.model||!c.thread.projectId||c.model.shareProject||t.public)&&
    (!t.file||(!c.model||c.model.shareAttachments)&&(t.file==='read'?policy.readRoots.length:policy.writeRoots.length)>0)&&
    (!c.model||c.thread.projectId||c.model.sharePersonal||Boolean(t.file)||t.public)&&t.allowed?.(c)!==false
}
const builtin=new Map(tools.map(tool=>[tool.name,toolEntry({...tool,allowed:(c:Core)=>enabled(c,tool,chatPolicy(c.dir))})]))
const coordinationTools=new Set(['task_progress','task_communications','task_check_delivery','task_coordination_status','utility_calculate','utility_time'])
const available=(c:Core,entry:RegisteredTool<Core>)=>
  (c.actor==='user'||!!c.coordination&&coordinationTools.has(entry.name))&&entry.allowed?.(c)!==false
export function toolsFor(c:Core){
  return [...builtin.values(),...(c.plugins?.tools.values()??[])].filter(t=>available(c,t))
    .map(({name,description,parameters})=>({name,description,parameters}))
}
export function toolCall(c:Core,name:string,raw:string){
  const entry=builtin.get(name)??c.plugins?.tools.get(name)
  if(!entry||!available(c,entry))fail('当前未授权该工具或资料范围',403)
  const args=parseTool(entry,raw)
  if(projectRouteTools.has(name)&&args.projectId!=null){
    const projectId=required(args.projectId,'项目 ID')
    if(c.actor!=='user'||c.model&&!c.model.shareProject||c.thread.projectId&&c.thread.projectId!==projectId)fail('当前模型或会话未获准路由到该项目',403)
    if(!one(c.db,'SELECT 1 FROM projects WHERE id=?',projectId))fail('路由项目不存在',404)
    if(!c.thread.projectId)c={...c,thread:{...c.thread,projectId},allowedInstances:routingBots(c.db,projectId),materials:[],attachmentIds:[]}
  }
  const needsConfirmation=typeof entry.confirm==='function'?entry.confirm(args):entry.confirm===true
  const confirm=needsConfirmation&&!routineWrite(c,name,args)
  if(confirm&&c.actor!=='user')fail('这项操作须由真实用户发起并确认',403)
  return {confirm,async:entry.async===true,execute:()=>entry.execute(c,args)}
}
function routineWrite(c:Core,name:string,args:Record<string,unknown>){
  if(c.actor!=='user')return false
  const policy=chatPolicy(c.dir)
  if(policy.routineRouting&&policy.task){
    if(name==='task_delegate'&&[undefined,'off','notify'].includes(args.coordination as any)&&!args.handoffTargets)return true
    if(name==='task_control'&&['message','steer'].includes(String(args.action)))return true
    if(name==='bot_native_import')return true
  }
  if(!policy.routineWrites)return false
  if(name==='home_record_save')return ['note','todo'].includes(String(args.type))&&!args.sourceId&&!args.refs
  if(name==='home_collection_entries')return args.action==='create'
  if(name!=='utility_daily')return false
  if(args.action==='create')return args.kind==='todo'
  return args.action==='complete'&&typeof args.id==='string'&&args.body===undefined&&args.dueAt===undefined&&
    !!one(c.db,"SELECT 1 FROM daily_items WHERE id=? AND projectId IS ? AND kind='todo' AND state='open'",args.id,c.thread.projectId)
}
