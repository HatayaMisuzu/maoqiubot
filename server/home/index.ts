import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, iso, list, now, obj, one, parse, projectAccess, revision, rows, run, str, strings, uid } from './common.ts';
import type { DB, Context, Principal } from './common.ts';
import { initSpaces, createSpace, spaceApi } from './spaces.ts';
import { memoryCandidates, search } from './search.ts';
import { resetChatContext, sharedRecordSql } from './visibility.ts';

const recordTypes = ['requirement','decision','preference','note','conclusion','handoff','comment','reply','todo','result','progress','start','artifact','verified','next','blocked','failure','stopped','partial','completed'];
const maxAttachmentBytes=16*1024*1024;
export function initHome(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, binding TEXT, space_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL, url TEXT, author TEXT NOT NULL,
      platform TEXT NOT NULL, submitter TEXT NOT NULL, created_at TEXT NOT NULL, acl TEXT NOT NULL, attachment_ids TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL, acl TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), task_id TEXT, kind TEXT NOT NULL, author TEXT NOT NULL,
      submitter TEXT NOT NULL, source_id TEXT REFERENCES sources(id), revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, forgotten INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS record_revisions (record_id TEXT NOT NULL REFERENCES records(id), rev INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(record_id,rev));
    CREATE INDEX IF NOT EXISTS records_project_time ON records(project_id,created_at);
    CREATE TABLE IF NOT EXISTS extraction_blocks (source_id TEXT NOT NULL REFERENCES sources(id), kind TEXT NOT NULL, fact_key TEXT NOT NULL,
      scope TEXT NOT NULL, PRIMARY KEY(source_id,kind,fact_key,scope));
  `);
  if(!rows(db,'PRAGMA table_info(extraction_blocks)').some(x=>x.name==='scope')) {
    db.exec(`
      SAVEPOINT extraction_scope;
      ALTER TABLE extraction_blocks RENAME TO old_extraction_blocks;
      CREATE TABLE extraction_blocks (source_id TEXT NOT NULL REFERENCES sources(id),kind TEXT NOT NULL,fact_key TEXT NOT NULL,scope TEXT NOT NULL,
        PRIMARY KEY(source_id,kind,fact_key,scope));
      INSERT OR IGNORE INTO extraction_blocks SELECT o.source_id,o.kind,o.fact_key,COALESCE(r.project_id,'') FROM old_extraction_blocks o
        LEFT JOIN records r ON r.source_id=o.source_id AND r.kind=o.kind AND r.forgotten=1;
      DROP TABLE old_extraction_blocks;
      RELEASE extraction_scope;
    `);
  }
  const sourceColumns=rows(db,'PRAGMA table_info(sources)');
  if(!sourceColumns.some(x=>x.name==='local_ref')) db.exec('ALTER TABLE sources ADD COLUMN local_ref TEXT');
  initSpaces(db);
}

function makeProject(db: DB, p: Principal, b: any) {
  if (!p.owner) fail(403,'只有所有者可以创建项目');
  const id = uid(), name = str(b.name,'name');
  const binding = b.binding == null ? null : typeof b.binding === 'string' ? str(b.binding,'binding') : obj(b.binding,'binding');
  run(db,'INSERT INTO projects VALUES(?,?,?,NULL,?)',id,name,JSON.stringify(binding),now());
  const space = createSpace(db,p,{projectId:id,name,templateSpaceId:b.templateSpaceId});
  run(db,'UPDATE projects SET space_id=? WHERE id=?',space.id,id);
  return getProject(db,id);
}
function getProject(db: DB, id: string) {
  const p = one(db,'SELECT * FROM projects WHERE id=?',id);
  const s = one(db,'SELECT structure FROM spaces WHERE id=?',p.space_id);
  return {id:p.id,name:p.name,binding:parse(p.binding ?? 'null'),spaceId:p.space_id,pageId:parse(s.structure).pages[0]?.id,createdAt:p.created_at};
}
type ACL = {projects:string[], endpoints:string[]};
function acl(db: DB, p: Principal, b: any): ACL {
  const projects = strings(b.projectIds ?? (b.projectId ? [b.projectId] : []),'projectIds');
  const endpoints = strings(b.endpointIds ?? [],'endpointIds');
  if (!p.owner && (!projects.length || endpoints.length)) fail(403,'缺少资料授权权限');
  for (const id of projects) projectAccess(db,p,id);
  return {projects,endpoints};
}
function canRead(a: ACL, p: Principal) {
  return p.owner || a.projects.some(id=>p.projects.includes(id)) || (!p.runPermission && a.endpoints.includes(p.id));
}
function canReferenceAsset(db:DB,p:Principal,table:'sources'|'attachments',id:string,projectId:string|null) {
  const row=one(db,`SELECT acl FROM ${table} WHERE id=?`,id);
  if (!row) return false;
  const access:ACL=parse(row.acl);
  return canRead(access,p) && (!projectId || access.projects.includes(projectId));
}
function asset(db: DB, p: Principal, table: 'sources'|'attachments', id: string) {
  const a = one(db,`SELECT * FROM ${table} WHERE id=?`,id);
  if (!a) fail(404,'资料不存在');
  if (!canRead(parse(a.acl),p)) fail(403,'缺少资料权限');
  return a;
}
function source(db: DB, p: Principal, id: string, projectId:string|null=null) {
  const a = asset(db,p,'sources',id);
  const access:ACL=parse(a.acl);
  if (projectId && !access.projects.includes(projectId)) fail(403,'资料尚未授权给此项目');
  return {id:a.id,title:a.title,text:a.text,url:a.url,author:a.author,platform:a.platform,submitter:a.submitter,createdAt:a.created_at,
    localRef:a.local_ref ? parse(a.local_ref) : null,
    attachmentIds:(parse(a.attachment_ids) as string[]).filter(aid=>canReferenceAsset(db,p,'attachments',aid,projectId)),
    projectIds:access.projects.filter(pid=>p.owner || p.projects.includes(pid)),endpointIds:access.endpoints.filter(eid=>p.owner || p.id===eid)};
}
function attachment(db: DB, ctx: Context, id: string, withData: boolean) {
  const a = asset(db,ctx.principal,'attachments',id);
  const access:ACL=parse(a.acl),p=ctx.principal;
  return {id:a.id,name:a.name,contentType:a.mime,size:a.bytes,createdAt:a.created_at,
    projectIds:access.projects.filter(pid=>p.owner||p.projects.includes(pid)),
    endpointIds:access.endpoints.filter(eid=>p.owner||p.id===eid),
    ...(withData ? {data:readFileSync(join(ctx.dataDir,'attachments',a.id)).toString('base64')} : {})};
}
function storeAttachment(db: DB, ctx: Context) {
  const b = ctx.body, access = acl(db,ctx.principal,b), name = str(b.name,'name');
  if (typeof b.data==='string' && b.data.length>4*Math.ceil(maxAttachmentBytes/3)) fail(413,'单个附件不能超过 16 MiB');
  if (typeof b.data !== 'string' || b.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.data)) fail(400,'data 应为 base64');
  const buf = Buffer.from(b.data,'base64');
  if (buf.length>maxAttachmentBytes) fail(413,'单个附件不能超过 16 MiB');
  if (buf.toString('base64') !== b.data) fail(400,'无效 base64');
  const id = uid(), mime = str(b.contentType ?? 'application/octet-stream','contentType');
  if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mime)) fail(400,'无效的附件媒体类型');
  const folder = join(ctx.dataDir,'attachments');
  mkdirSync(folder,{recursive:true,mode:0o700});
  const destination=join(folder,id);
  writeFileSync(destination,buf,{flag:'wx',mode:0o600});
  try { run(db,'INSERT INTO attachments VALUES(?,?,?,?,?,?)',id,name,mime,buf.length,now(),JSON.stringify(access)); }
  catch(e){unlinkSync(destination);throw e;}
  return attachment(db,ctx,id,false);
}
function extractKey(s: string) { return s.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase(); }
function recordValues(b:any) {
  const validFrom=iso(b.validFrom,'validFrom'), validUntil=iso(b.validUntil,'validUntil');
  if (validFrom && validUntil && validUntil <= validFrom) fail(400,'有效期结束早于开始');
  const confirmation = b.confirmation ?? 'unconfirmed';
  if (!['user','confirmed','unconfirmed','inferred','observed'].includes(confirmation)) fail(400,'无效确认性质');
  return {body:str(b.body,'body'),extra:obj(b.extra ?? {},'extra'),confirmation,validFrom,validUntil,
    refs:strings(b.refs ?? [],'refs'),factKey:b.factKey == null ? null : str(b.factKey,'factKey'),
    shareDerived:b.shareDerived!==false,independentKnowledge:b.independentKnowledge===true};
}
function checkSharing(p:Principal,projectId:string|null,b:any){
  if(!['shareDerived','independentKnowledge'].some(k=>Object.hasOwn(b,k)))return
  if(!p.owner||!projectId)fail(403,'只有所有者可管理项目派生知识共享')
  for(const key of ['shareDerived','independentKnowledge'])
    if(Object.hasOwn(b,key)&&typeof b[key]!=='boolean')fail(400,'派生知识选项须为布尔值')
  if(b.independentKnowledge===true&&b.confirmation!=='user')fail(400,'独立项目知识需要所有者确认')
}
function assertUnblocked(db:DB,sourceId:string|null,kind:string,v:any,projectId:string|null) {
  if (!sourceId) return;
  const match=one(db,'SELECT 1 FROM extraction_blocks WHERE source_id=? AND kind=? AND scope=? AND fact_key IN (?,?)',sourceId,kind,projectId ?? '',extractKey(v.body),extractKey(v.factKey ?? v.body));
  if (match) fail(409,'该来源的此条提炼已被遗忘');
}
function toRecord(row:any) {
  return {id:row.id,projectId:row.project_id,taskId:row.task_id,type:row.kind,author:row.author,submitter:row.submitter,
    sourceId:row.source_id,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,...parse(row.snapshot)};
}
const recordSelect='SELECT r.*, v.snapshot FROM records r JOIN record_revisions v ON v.record_id=r.id AND v.rev=r.revision';
function record(db:DB,p:Principal,id:string) {
  const r=one(db,recordSelect+` WHERE r.id=? AND r.forgotten=0 AND (? OR ${sharedRecordSql()})`,id,Number(p.owner));
  if (!r) fail(404,'记录不存在');
  projectAccess(db,p,r.project_id);
  return toRecord(r);
}
function visibleRecord(db:DB,p:Principal,r:ReturnType<typeof toRecord>) {
  if (r.sourceId && !canReferenceAsset(db,p,'sources',r.sourceId,r.projectId)) return {...r,sourceId:null};
  return r;
}
function insertRecord(db:DB,projectId:string|null,taskId:string|null,kind:string,author:string,submitter:string,sourceId:string|null,b:any) {
  const v={...recordValues(b),confirmationBy:submitter}, id=uid(), at=now();
  assertUnblocked(db,sourceId,kind,v,projectId);
  run(db,'INSERT INTO records VALUES(?,?,?,?,?,?,?,1,?,?,0)',id,projectId,taskId,kind,author,submitter,sourceId,at,at);
  run(db,'INSERT INTO record_revisions VALUES(?,1,?,?)',id,JSON.stringify(v),at);
  return {id,projectId,taskId,type:kind,author,submitter,sourceId,revision:1,createdAt:at,updatedAt:at,...v};
}
function forgetRecord(db:DB,r:any) {
  const keys=new Set<string>();
  if(r.sourceId) {
    for(const h of rows(db,'SELECT snapshot FROM record_revisions WHERE record_id=?',r.id)) {
      const v=parse(h.snapshot);
      for(const key of [v.body,v.factKey].filter(Boolean)) keys.add(extractKey(key));
    }
    for(const key of keys) run(db,'INSERT OR IGNORE INTO extraction_blocks VALUES(?,?,?,?)',r.sourceId,r.type,key,r.projectId ?? '');
  }
  const scoped=rows(db,recordSelect+' WHERE r.project_id IS ? AND r.forgotten=0',r.projectId).map(toRecord);
  const forgotten=new Set<string>([r.id]);
  for(const item of scoped) {
    if(r.sourceId && item.sourceId===r.sourceId && item.type===r.type &&
        (keys.has(extractKey(item.body)) || item.factKey && keys.has(extractKey(item.factKey)))) forgotten.add(item.id);
  }
  // A derived conclusion explicitly lists its source records. Conversation replies and handoffs remain independent records.
  let count=0;
  while(forgotten.size!==count) {
    count=forgotten.size;
    for(const item of scoped) if(item.type==='conclusion' && item.refs.some((ref:string)=>forgotten.has(ref))) forgotten.add(item.id);
  }
  const at=now();
  for(const id of forgotten) run(db,'UPDATE records SET forgotten=1,updated_at=? WHERE id=?',at,id);
  resetChatContext(db,r.projectId);
  return {id:r.id,forgotten:true,affectedIds:[...forgotten]};
}
export function addTaskRecord(db:DB,projectId:string|null,taskId:string,type:string,body:string,extra:object={}) {
  if (projectId) return insertRecord(db,projectId,taskId,type,'工作台','server',null,{body,extra,confirmation:'observed'});
}
function userRecord(db:DB,p:Principal,projectId:string|null,b:any) {
  projectAccess(db,p,projectId);
  checkSharing(p,projectId,b);
  const kind=str(b.type ?? 'note','type');
  if (!recordTypes.includes(kind)) fail(400,'未知记录类型');
  if(p.runPermission && kind==='verified') fail(403,'运行令牌不能提交验收结论');
  if(p.runPermission && ['user','confirmed','observed'].includes(b.confirmation)) b={...b,confirmation:'unconfirmed'};
  const src=b.sourceId == null ? null : str(b.sourceId,'sourceId');
  if (src) {
    const s=source(db,p,src);
    if (projectId && !s.projectIds.includes(projectId)) fail(400,'请先将来源授权给此项目');
  }
  for (const rid of strings(b.refs ?? [],'refs')) {
    const ref=record(db,p,rid);
    if (ref.projectId !== projectId) fail(400,'仅支持同一范围的记录引用');
  }
  return insertRecord(db,projectId,null,kind,str(b.author ?? p.id,'author'),p.id,src,b);
}
function writeSubmission(db:DB,ctx:Context) {
  const {principal:p,body:b}=ctx,s=obj(b.source,'source'),a=acl(db,p,{...b,...s});
  const id=uid(), attachments=strings(s.attachmentIds ?? [],'attachmentIds');
  for (const aid of attachments) {
    const aa:ACL=parse(asset(db,p,'attachments',aid).acl);
    if (!a.projects.every(x=>aa.projects.includes(x)) || !a.endpoints.every(x=>aa.endpoints.includes(x))) fail(400,'附件与资料的访问范围不匹配');
  }
  let url=null;
  if (s.url) {
    try { const u=new URL(s.url); if(!['https:','http:'].includes(u.protocol)) throw Error(); url=u.href; } catch { fail(400,'链接须为 HTTP(S) 网址'); }
  }
  const title=str(s.title,'title'), author=str(s.author ?? p.id,'author');
  const content=s.text ?? '';
  if(typeof content!=='string') fail(400,'text 应为文本');
  let localRef=null;
  if(s.localRef!=null) {
    const ref=obj(s.localRef,'localRef');
    localRef=JSON.stringify({nodeId:str(ref.nodeId,'nodeId'),workspaceRef:str(ref.workspaceRef,'workspaceRef'),path:str(ref.path,'path')});
  }
  run(db,'INSERT INTO sources (id,title,text,url,author,platform,submitter,created_at,acl,attachment_ids,local_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    id,title,content,url,author,str(s.platform ?? 'workbench','platform'),p.id,now(),JSON.stringify(a),JSON.stringify(attachments),localRef);
  const records=list(b.records ?? [],'records').map(r=>userRecord(db,p,b.projectId ?? a.projects[0] ?? null,{...obj(r,'record'),sourceId:id}));
  return {source:source(db,p,id),sourceId:id,records};
}
function current(r:any, at=now()) { return (!r.validFrom || r.validFrom<=at) && (!r.validUntil || r.validUntil>at); }
function timeline(db:DB,p:Principal,id:string,strictSources=false) {
  return rows(db,recordSelect+` WHERE r.project_id=? AND r.forgotten=0 AND (? OR ${sharedRecordSql()})
    ORDER BY r.created_at DESC,r.rowid DESC`,id,Number(p.owner&&!strictSources))
    .map(row=>visibleRecord(db,p,toRecord(row)));
}
function brief(db:DB,p:Principal,id:string,strictSources=false) {
  const project=getProject(db,id),records=timeline(db,p,id,strictSources).filter(r=>current(r));
  const personalPrefs=p.owner ? rows(db,recordSelect+" WHERE r.project_id IS NULL AND r.kind='preference' AND r.forgotten=0 ORDER BY r.updated_at DESC").map(toRecord).filter(r=>current(r)) : [];
  const by=(...ks:string[])=>records.filter(r=>ks.includes(r.type));
  const work=records.filter(r=>r.taskId || ['result','progress','handoff','artifact'].includes(r.type));
  const deliveryByRun=new Map<string,{version?:unknown,artifacts?:unknown[]}>();
  for (const r of work) {
    if (!r.taskId || typeof r.extra.runId!=='string') continue;
    const key=r.taskId+':'+r.extra.runId, delivery=deliveryByRun.get(key) ?? {};
    if (delivery.version==null && r.extra.version!=null) delivery.version=r.extra.version;
    if (!delivery.artifacts && Array.isArray(r.extra.artifacts)) delivery.artifacts=r.extra.artifacts;
    deliveryByRun.set(key,delivery);
  }
  const seen=new Set<string>();
  const superseded=new Set(by('handoff').flatMap(r=>r.refs));
  const latestWork=work.filter(r=>{
    if(r.type==='handoff' && superseded.has(r.id)) return false;
    if(!r.taskId) return true;
    if(seen.has(r.taskId)) return false;
    seen.add(r.taskId);
    return true;
  }).map(r=>{
    const delivery=deliveryByRun.get(r.taskId+':'+r.extra.runId);
    return delivery ? {...r,extra:{...r.extra,...delivery}} : r;
  });
  const openItems=[...new Set([...by('todo').filter(r=>r.extra.status!=='done').map(r=>r.body),
    ...latestWork.flatMap(r=>Array.isArray(r.extra.remaining)?r.extra.remaining.filter((v:any)=>typeof v==='string'):[])])];
  const verified:any[]=[],claimedVerification:any[]=[],pendingVerification:any[]=[],nextSteps:any[]=[];
  for (const r of latestWork) {
    const provenance={id:r.id,sourceId:r.sourceId,taskId:r.taskId,author:r.author};
    const checks=Array.isArray(r.extra.verified)?r.extra.verified:[];
    const trusted=r.submitter==='server' && ['user','workbench'].includes(r.extra.verificationSource);
    const evidenceSource=trusted?(r.extra.verificationSource??'user'):'self_reported';
    const met=new Set<string>();
    for (const check of checks) {
      const body=typeof check==='string'?check:check?.met===true&&typeof check.criterion==='string'?check.criterion:null;
      if(!body)continue;
      if(trusted)met.add(body);
      (trusted?verified:claimedVerification).push({...provenance,body,verificationSource:evidenceSource,
        at:r.createdAt,reviewId:trusted?(r.extra.reviewId??null):null,
        ...(typeof check?.evidence==='string'?{evidence:check.evidence}:{})});
    }
    if (['partial','awaiting_review'].includes(r.extra.status) && Array.isArray(r.extra.doneWhen)) {
      const criteria=r.extra.doneWhen.filter((value:unknown)=>typeof value==='string' && !met.has(value));
      if (criteria.length) pendingVerification.push({recordId:r.id,taskId:r.taskId,criteria});
    }
    if (Array.isArray(r.extra.nextSteps)) for (const body of r.extra.nextSteps) {
      if (typeof body==='string') nextSteps.push({...provenance,body});
    }
  }
  const externalChecks=by('verified').filter(r=>r.submitter!=='owner');
  return {project,requirements:by('requirement'),preferences:[...by('preference'),...personalPrefs],decisions:by('decision'),latestWork,
    handoffs:by('handoff'),openItems,pendingVerification,
    verified:[...by('verified').filter(r=>r.submitter==='owner').map(r=>({...r,verificationSource:'user'})),...verified],
    claimedVerification:[...externalChecks.map(r=>({...r,verificationSource:'self_reported'})),...claimedVerification],
    nextSteps:[...by('next'),...nextSteps],records};
}
const claimsConfirmation=(value:unknown)=>['user','confirmed','observed'].some(status=>status===value);
const confirmed=(r:any)=>['owner','server'].includes(r.confirmationBy??r.submitter) && claimsConfirmation(r.confirmation);
function factRecord(r:any) {
  const confirmation=claimsConfirmation(r.confirmation)&&!confirmed(r)?'unconfirmed':r.confirmation;
  return {id:r.id,type:r.type,body:r.body,confirmation,sourceId:r.sourceId,revision:r.revision};
}
function effectiveFacts(records:any[]){
  const seen=new Set<string>();
  return [...records].sort((a,b)=>Number(confirmed(b))-Number(confirmed(a))||b.updatedAt.localeCompare(a.updatedAt))
    .filter(r=>{
      if(!r.factKey)return true;
      const key=r.type+':'+extractKey(r.factKey);
      if(seen.has(key))return false;
      seen.add(key);return true;
    });
}
export function prepareProjectContext(db:DB,id:string) {
  // The context follows the project ACL even when assembled for an owner action.
  const p:Principal={id:'',owner:false,projects:[id]};
  const data=brief(db,p,id,true);
  let factBudget=12000;
  const facts=effectiveFacts([...data.requirements,...data.decisions,...data.preferences]).flatMap(r=>{
    if(factBudget<=0)return [];
    const body=r.body.slice(0,Math.min(factBudget,confirmed(r)?1800:1000));
    factBudget-=body.length+100;
    return [factRecord({...r,body})];
  });
  const superseded=new Set(data.handoffs.flatMap(r=>r.refs));
  const handoffs=data.handoffs.filter(r=>!superseded.has(r.id)).slice(0,3).map(r=>({
    ...factRecord(r),body:r.body.slice(0,1800),version:r.extra?.version,
    remaining:Array.isArray(r.extra?.remaining)?r.extra.remaining.slice(0,8).filter((v:any)=>typeof v==='string').map((v:string)=>v.slice(0,400)):[]
  }));
  return {project:{id,name:data.project.name},facts,handoffs,openItems:data.openItems.slice(0,12).map(item=>item.slice(0,500)),
    pendingVerification:data.pendingVerification.slice(0,6).map(r=>({...r,criteria:r.criteria.slice(0,6).map((s:string)=>s.slice(0,400))})),
    ...(factBudget<=0?{moreFacts:true}:{})};
}
export function recallMemory(db:DB,projectId:string|null,text:string){
  const words=text.toLowerCase().slice(0,600).match(/\p{Script=Han}+|[\w.-]{2,}/gu)??[];
  const terms=[...new Set(words.flatMap(word=>{
    const chars=Array.from(word)
    if(!/\p{Script=Han}/u.test(word)||chars.length<=2)return [word]
    return chars.flatMap((_,i)=>[chars.slice(i,i+3).join(''),chars.slice(i,i+2).join('')]).filter(term=>term.length>=2)
  }))].slice(0,36);
  if(!terms.length)return [];
  const candidates=memoryCandidates(db,projectId,terms).map(toRecord);
  const p:Principal=projectId?{id:'main',owner:false,projects:[projectId]}:{id:'owner',owner:true,projects:[]};
  const winners=new Map<string,string>();
  return candidates.filter(r=>{
    if(!r.factKey)return true
    const key=r.type+'\0'+extractKey(r.factKey)
    if(!winners.has(key)){
      const alternatives=rows(db,recordSelect+` WHERE r.project_id IS ? AND r.kind=? AND r.forgotten=0
        AND maoqiu_fact_key(json_extract(v.snapshot,'$.factKey'))=? AND (? OR ${sharedRecordSql()})
        ORDER BY r.updated_at DESC,r.rowid DESC`,projectId,r.type,extractKey(r.factKey),Number(!projectId))
        .map(toRecord).filter(candidate=>current(candidate))
      winners.set(key,effectiveFacts(alternatives)[0]?.id??r.id)
    }
    return winners.get(key)===r.id
  }).slice(0,6).map(r=>({...factRecord({...visibleRecord(db,p,r),body:r.body.slice(0,800)}),projectId:r.projectId}));
}
export function memoryFact(db:DB,projectId:string|null,type:string,key:string){
  const alternatives=rows(db,recordSelect+` WHERE r.project_id IS ? AND r.kind=? AND r.forgotten=0
    AND maoqiu_fact_key(json_extract(v.snapshot,'$.factKey'))=? AND (? OR ${sharedRecordSql()})
    ORDER BY r.updated_at DESC,r.rowid DESC`,projectId,type,extractKey(key),Number(!projectId)).map(toRecord).filter(r=>current(r));
  return effectiveFacts(alternatives)[0];
}
export function homeApi(db:DB,ctx:Context):any {
  const {path,method,principal:p}=ctx, b=ctx.body ?? {};
  const [,area,id,action]=path.split('/');
  if(p.runPermission && method!=='GET'){
    const append=method==='POST' && (['/records','/submissions','/attachments'].includes(path) || /^\/projects\/[^/]+\/records$/.test(path));
    if(p.runPermission==='read' || (p.runPermission==='append' && !append)) fail(403,'运行令牌没有此项写入权限');
  }
  if (area==='projects') {
    if (path==='/projects' && method==='POST') return makeProject(db,p,b);
    if (path==='/projects' && method==='GET') return {items:rows(db,'SELECT id FROM projects ORDER BY created_at DESC').filter(x=>p.owner || p.projects.includes(x.id)).map(x=>getProject(db,x.id))};
    if (!id) return;
    projectAccess(db,p,id);
    if (!action && method==='GET') return getProject(db,id);
    if (action==='brief' && method==='GET') return brief(db,p,id);
    if (action==='timeline' && method==='GET') return {items:timeline(db,p,id)};
    if (action==='records' && method==='POST') return userRecord(db,p,id,b);
  }
  if (path==='/submissions' && method==='POST') return writeSubmission(db,ctx);
  if (path==='/search' && method==='GET') return search(db,ctx);
  if (path==='/attachments' && method==='POST') return storeAttachment(db,ctx);
  if (id && !action && (area==='attachments'||area==='sources')) {
    if(method==='PATCH') {
      if(!p.owner) fail(403,'只有所有者可调整资料访问范围');
      if(!['projectIds','projectId','endpointIds'].some(k=>Object.hasOwn(b,k))) fail(400,'请指定新的访问范围');
      const a=acl(db,p,b);
      const original=asset(db,p,area,id);
      if(area==='sources') {
        for(const aid of parse(original.attachment_ids)) {
          const aa:ACL=parse(asset(db,p,'attachments',aid).acl);
          if(!a.projects.every(x=>aa.projects.includes(x)) || !a.endpoints.every(x=>aa.endpoints.includes(x))) fail(400,'请先授权附件');
        }
      }
      run(db,`UPDATE ${area} SET acl=? WHERE id=?`,JSON.stringify(a),id);
      for(const projectId of (parse(original.acl) as ACL).projects)
        if(!a.projects.includes(projectId))resetChatContext(db,projectId);
    }
    if(method==='GET' || method==='PATCH'){
      const projectId=area==='sources' && method==='GET'?ctx.query.get('projectId'):null;
      if(projectId)projectAccess(db,p,projectId);
      return area==='sources'?source(db,p,id,projectId):attachment(db,ctx,id,method==='GET' && ctx.query.get('meta')!=='1');
    }
  }
  if (path==='/records' && method==='POST') return userRecord(db,p,b.projectId ?? null,b);
  if (area==='records' && id && !action) {
    const r=record(db,p,id);
    const visible=visibleRecord(db,p,r);
    if (method==='GET') {
      if(ctx.query.get('history')==='1') return {...visible,history:rows(db,`SELECT v.rev,v.snapshot,v.created_at
        FROM record_revisions v JOIN records r ON r.id=v.record_id WHERE r.id=? AND (? OR ${sharedRecordSql()})
        ORDER BY v.rev DESC`,id,Number(p.owner)).map(h=>({revision:h.rev,createdAt:h.created_at,...parse(h.snapshot)}))};
      return visible;
    }
    const protectedRecord=r.submitter==='server' || r.type==='verified'&&r.submitter==='owner' ||
      confirmed(r)&&['requirement','decision','preference'].includes(r.type);
    if (method==='PATCH') {
      revision(r.revision,b.expectedRevision,visible);
      if(!p.owner && protectedRecord) fail(403,'此记录由工作台或所有者维护');
      checkSharing(p,r.projectId,b);
      const confirmation=p.runPermission && ['user','confirmed','observed'].includes(b.confirmation??r.confirmation)?'unconfirmed':b.confirmation??r.confirmation;
      const confirmationBy=p.owner&&!Object.hasOwn(b,'confirmation')?(r.confirmationBy??r.submitter):p.id;
      const changedBody=b.body!==undefined&&b.body!==r.body
      const independentKnowledge=b.independentKnowledge??(changedBody?false:r.independentKnowledge);
      const v={...recordValues({...r,...b,confirmation,independentKnowledge}),confirmationBy};
      for (const ref of v.refs) if (record(db,p,ref).projectId!==r.projectId) fail(400,'引用范围不一致');
      assertUnblocked(db,r.sourceId,r.type,v,r.projectId);
      const n=r.revision+1,at=now();
      run(db,'UPDATE records SET revision=?,updated_at=? WHERE id=?',n,at,id);
      run(db,'INSERT INTO record_revisions VALUES(?,?,?,?)',id,n,JSON.stringify(v),at);
      resetChatContext(db,r.projectId);
      return visibleRecord(db,p,{...r,...v,revision:n,updatedAt:at} as ReturnType<typeof toRecord>);
    }
    if (method==='DELETE') {
      if(!p.owner && protectedRecord) fail(403,'此记录由工作台或所有者维护');
      revision(r.revision,b.expectedRevision,visible);
      return forgetRecord(db,r);
    }
  }
  return spaceApi(db,ctx,projectId=>({
    openSource:sourceId=>source(db,p,sourceId,projectId),
    writeHandoff:record=>userRecord(db,p,projectId,{...record,type:'handoff'}),
    canReference:(kind,ref)=>kind==='record'
      ? Boolean(one(db,recordSelect+` WHERE r.id=? AND r.project_id IS ? AND r.forgotten=0
        AND (? IS NULL OR ${sharedRecordSql()})`,ref,projectId,projectId))
      : canReferenceAsset(db,p,kind==='source'?'sources':'attachments',ref,projectId)
  }));
}
