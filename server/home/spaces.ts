import type { DB, Context, Principal } from './common.ts';
import { fail, list, now, obj, one, parse, projectAccess, revision, rows, run, str, uid } from './common.ts';

type RefKind='source'|'attachment'|'record';
type Hooks={openSource:(id:string)=>any,writeHandoff:(record:Record<string,unknown>)=>any,canReference:(kind:RefKind,id:string)=>boolean};
type Field={id:string,name:string,type:string,options?:string[]};
type Collection={id:string,name:string,fields:Field[]};
type Block={id:string,type:string,title?:string,config:Record<string,any>,actions:any[]};
type Page={id:string,title:string,columns:number,blocks:Block[]};
type Structure={name:string,theme:string,cover:string|null,pages:Page[],collections:Collection[],disabledModules:string[]};
type Space={id:string,projectId:string|null,revision:number,structure:Structure};
const fields=['text','date','select','number','attachment','record'];
const actions=['openSource','addEntry','writeHandoff'];
const moduleTypes=[
  {type:'brief',name:'项目简报',config:{},actions:[]},
  {type:'timeline',name:'项目时间线',config:{},actions:['writeHandoff']},
  {type:'collection',name:'集合视图',config:{collectionId:'collection'},actions:['addEntry']},
  {type:'text',name:'正文',config:{text:'text'},actions:[]},
  {type:'reference',name:'来源引用',config:{sourceId:'source'},actions:['openSource']},
  {type:'source-card',name:'资料出处',config:{sourceId:'source'},actions:['openSource'],fallback:'reference'}
].map(m=>({...m,version:1,renderer:m.type}));
export function initSpaces(db:DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), revision INTEGER NOT NULL, structure TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS space_revisions (space_id TEXT NOT NULL REFERENCES spaces(id), revision INTEGER NOT NULL, structure TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(space_id,revision));
    CREATE TABLE IF NOT EXISTS space_collections (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id));
    CREATE TABLE IF NOT EXISTS collection_entries (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES space_collections(id), value_json TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS entries_collection ON collection_entries(collection_id,created_at);
  `);
  if(!one(db,'SELECT 1 FROM spaces WHERE id=?','personal')) {
    const s=defaultStructure('个人空间');
    saveNew(db,'personal',null,s);
  }
}
function defaultStructure(name:string):Structure {
  const c:Collection={id:uid(),name:'资料',fields:[{id:'title',name:'名称',type:'text'},{id:'category',name:'分类',type:'text'}]};
  const blocks:Block[]=[
    {id:uid(),type:'brief',title:'当前要求',config:{},actions:[]},
    {id:uid(),type:'timeline',title:'最近进度',config:{},actions:[]},
    {id:uid(),type:'collection',title:'资料',config:{collectionId:c.id},actions:[]}
  ];
  return {name,theme:'default',cover:null,pages:[{id:uid(),title:'首页',columns:1,blocks}],collections:[c],disabledModules:[]};
}
function saveNew(db:DB,id:string,projectId:string|null,structure:Structure) {
  const json=JSON.stringify(structure);
  run(db,'INSERT INTO spaces VALUES(?,?,1,?)',id,projectId,json);
  run(db,'INSERT INTO space_revisions VALUES(?,1,?,?)',id,json,now());
  for (const c of structure.collections) run(db,'INSERT INTO space_collections VALUES(?,?)',c.id,id);
  return {id,projectId,revision:1,structure};
}
function getSpace(db:DB,p:Principal,id:string):Space {
  const s=one(db,'SELECT * FROM spaces WHERE id=?',id);
  if (!s) fail(404,'空间不存在');
  projectAccess(db,p,s.project_id);
  return {id:s.id,projectId:s.project_id,revision:s.revision,structure:parse(s.structure)};
}
function cloneStructure(src:Structure):Structure {
  const s=structuredClone(src), map=new Map<string,string>();
  for(const c of s.collections) { const old=c.id; c.id=uid(); map.set(old,c.id); }
  for(const page of s.pages) {
    page.id=uid();
    for(const b of page.blocks){
      b.id=uid();
      const c=s.collections.find(c=>c.id===map.get(b.config.collectionId));
      const filterType=c?.fields.find(f=>f.id===b.config.filter?.fieldId)?.type;
      if(filterType==='attachment' || filterType==='record') delete b.config.filter;
      if(b.config.collectionId) b.config.collectionId=map.get(b.config.collectionId);
      delete b.config.sourceId; delete b.config.attachmentId;
      for(const a of b.actions) { a.id=uid(); if(a.params?.collectionId) a.params.collectionId=map.get(a.params.collectionId); if(a.params) delete a.params.sourceId; }
    }
  }
  return s;
}
export function createSpace(db:DB,p:Principal,b:any) {
  const projectId=b.projectId ?? null;
  projectAccess(db,p,projectId);
  const s=b.templateSpaceId ? cloneStructure(getSpace(db,p,str(b.templateSpaceId,'templateSpaceId')).structure) : defaultStructure(str(b.name ?? '新空间','name'));
  if(b.name) s.name=str(b.name,'name');
  return saveNew(db,uid(),projectId,s);
}
function byId<T extends {id:string}>(items:T[],id:unknown,label:string):T {
  return items.find(x=>x.id===id) ?? fail(404,`${label}不存在`);
}
function localId(v:unknown) {
  const id=v==null ? uid() : str(v,'id');
  if(!/^[\p{L}\p{N}_.-]{1,120}$/u.test(id) || ['__proto__','prototype','constructor'].includes(id)) fail(400,'无效对象 ID');
  return id;
}
function addUnique<T extends {id:string}>(items:T[],item:T,where?:number){
  if(items.some(x=>x.id===item.id)) fail(409,'对象 ID 重复');
  if(where!==undefined && (!Number.isInteger(where)||where<0||where>items.length)) fail(400,'无效位置');
  items.splice(where ?? items.length,0,item);
}
function asField(v:any):Field {
  obj(v,'field');
  if (!fields.includes(v.type)) fail(400,'未知字段类型');
  const options=v.options==null?undefined:list(v.options,'options').map(x=>str(x,'option'));
  return {id:localId(v.id),name:str(v.name,'field.name'),type:v.type,...(options?{options}:{})};
}
function asAction(v:any) {
  obj(v,'action');
  if (!actions.includes(v.type)) fail(400,'未知页面动作');
  const params=obj(v.params ?? {},'params');
  const allowed=v.type==='openSource'?['sourceId']:v.type==='addEntry'?['collectionId']:[];
  if(Object.keys(params).some(k=>!allowed.includes(k))) fail(400,'不支持的动作参数');
  for(const [key,value] of Object.entries(params)) str(value,key);
  return {id:localId(v.id),type:v.type,label:str(v.label ?? v.type,'action.label'),params};
}
function asBlock(v:any):Block {
  if(!['brief','timeline','collection','text','reference','source-card'].includes(v.type)) fail(400,'未知块类型');
  const actionsIn:any[]=[];
  for(const a of list(v.actions ?? [],'actions')) addUnique(actionsIn,asAction(a));
  return {id:localId(v.id),type:v.type,title:v.title == null ? undefined : str(v.title,'block.title'),config:obj(v.config ?? {},'config'),actions:actionsIn};
}
function columns(n:any) {
  if(!Number.isInteger(n) || n<1 || n>4) fail(400,'页面列数应为 1 至 4');
  return n;
}
function entry(row:any) { return {id:row.id,collectionId:row.collection_id,revision:row.revision,values:parse(row.value_json),createdAt:row.created_at,updatedAt:row.updated_at}; }
function readEntries(db:DB,id:string) { return rows(db,'SELECT * FROM collection_entries WHERE collection_id=? ORDER BY created_at,id',id).map(entry); }
function requireReference(h:Hooks|undefined,kind:RefKind,id:string) {
  if (h && !h.canReference(kind,id)) fail(403,'引用不适用于此空间');
}
function visibleValue(v:any,type:string,h:Hooks):any {
  if (v==null) return v;
  if (type==='attachment' && Array.isArray(v)) return v.filter(id=>typeof id==='string' && h.canReference('attachment',id.trim()));
  if (type==='attachment' || type==='record') return typeof v==='string' && h.canReference(type,v.trim())?v:undefined;
  return v;
}
function entryFields(db:DB,space:Space,c:Collection,entries:ReturnType<typeof entry>[]) {
  const types=new Map(c.fields.map(f=>[f.id,f.type]));
  const missing=new Set(entries.flatMap(e=>Object.keys(e.values)).filter(id=>!types.has(id)));
  if (missing.size) for (const row of rows(db,'SELECT structure FROM space_revisions WHERE space_id=? ORDER BY revision DESC',space.id)) {
    const old=(parse(row.structure) as Structure).collections.find(x=>x.id===c.id);
    for (const f of old?.fields ?? []) if (missing.delete(f.id)) types.set(f.id,f.type);
    if (!missing.size) break;
  }
  return types;
}
function visibleEntry(e:ReturnType<typeof entry>,types:Map<string,string>,h:Hooks) {
  const values=Object.entries(e.values).map(([id,value])=>[id,visibleValue(value,types.get(id) ?? '',h)]).filter(([,value])=>value!==undefined);
  return {...e,values:Object.fromEntries(values)};
}
function valueOk(v:any,f:Field,h?:Hooks) {
  if(v==null) return;
  if(f.type==='number') { if(typeof v!=='number' || !Number.isFinite(v)) fail(400,`${f.name} 应为数值`); return; }
  if(f.type==='attachment') { for(const a of Array.isArray(v)?v:[v]) requireReference(h,'attachment',str(a,f.name)); return; }
  if(typeof v!=='string') fail(400,`${f.name} 应为字符串`);
  if(f.type==='date' && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0,10)!==v)) fail(400,'无效日期');
  if(f.type==='select' && f.options && !f.options.includes(v)) fail(400,'选项不存在');
  if(f.type==='record') requireReference(h,'record',str(v,f.name));
}
function collectionFor(db:DB,p:Principal,id:string,allowArchived=false) {
  const reg=one(db,'SELECT space_id FROM space_collections WHERE id=?',id);
  if(!reg) fail(404,'集合不存在');
  const space=getSpace(db,p,reg.space_id);
  let c=space.structure.collections.find(x=>x.id===id);
  if(!c && allowArchived) {
    for(const r of rows(db,'SELECT structure FROM space_revisions WHERE space_id=? ORDER BY revision DESC',space.id)) {
      c=(parse(r.structure) as Structure).collections.find(x=>x.id===id);
      if(c) break;
    }
  }
  if(!c) fail(404,'当前布局中没有此集合');
  return {space,c};
}
function putEntry(db:DB,space:Space,c:Collection,b:any,h:Hooks,id?:string) {
  const edits=obj(b.values,'values');
  let existing:any=null;
  if(id) {
    const r=one(db,'SELECT * FROM collection_entries WHERE id=? AND collection_id=?',id,c.id);
    if(!r) fail(404,'条目不存在');
    existing=entry(r);
    revision(existing.revision,b.expectedRevision,visibleEntry(existing,entryFields(db,space,c,[existing]),h));
  }
  for(const [key,v] of Object.entries(edits)) valueOk(v,byId(c.fields,key,'字段'),h);
  const merged={...existing?.values,...edits},at=now(),eid=id??uid();
  if(existing) run(db,'UPDATE collection_entries SET value_json=?,revision=revision+1,updated_at=? WHERE id=?',JSON.stringify(merged),at,eid);
  else run(db,'INSERT INTO collection_entries VALUES(?,?,?,1,?,?)',eid,c.id,JSON.stringify(merged),at,at);
  const saved=entry(one(db,'SELECT * FROM collection_entries WHERE id=?',eid));
  return visibleEntry(saved,entryFields(db,space,c,[saved]),h);
}
type Migration={id:string,values:any};
function editStructure(db:DB,space:Space,ops:any[],h:Hooks) {
  const s=structuredClone(space.structure), summary:string[]=[], affectedPages:string[]=[], migrated=new Map<string,Migration>();
  const page=(id:any)=>byId(s.pages,id,'页面'), collection=(id:any)=>byId(s.collections,id,'集合');
  for(const raw of ops){
    const op=obj(raw,'operation');
    let affectedPage:unknown=op.pageId;
    switch(op.op) {
      case 'setSpace':
        if(op.name!=null) s.name=str(op.name,'name');
        if(op.theme!=null) s.theme=str(op.theme,'theme');
        if(Object.hasOwn(op,'cover')) s.cover=op.cover==null?null:str(op.cover,'cover');
        break;
      case 'createPage': {
        const v=op.page ?? op;
        const id=localId(v.id);
        addUnique(s.pages,{id,title:str(v.title,'page.title'),columns:columns(v.columns ?? 1),blocks:[]},op.index);
        affectedPage=id;
        break;
      }
      case 'updatePage': {
        const p=page(op.pageId);
        if(op.title!=null) p.title=str(op.title,'title');
        if(op.columns!=null) p.columns=columns(op.columns);
        break;
      }
      case 'movePage': {const p=page(op.pageId); s.pages.splice(s.pages.indexOf(p),1); addUnique(s.pages,p,op.index); break;}
      case 'removePage': { const p=page(op.pageId); if(s.pages.length===1) fail(400,'空间至少需要一页'); s.pages.splice(s.pages.indexOf(p),1); break; }
      case 'addBlock': addUnique(page(op.pageId).blocks,asBlock(obj(op.block,'block')),op.index); break;
      case 'updateBlock': {
        const bs=page(op.pageId).blocks,b=byId(bs,op.blockId,'块');
        bs[bs.indexOf(b)]=asBlock({...b,...obj(op.block,'block'),id:b.id}); break;
      }
      case 'removeBlock':
      case 'moveBlock': {
        const p=page(op.pageId),b=byId(p.blocks,op.blockId,'块'); p.blocks.splice(p.blocks.indexOf(b),1);
        if(op.op==='moveBlock') {
          const target=page(op.toPageId ?? p.id);
          addUnique(target.blocks,b,op.index);
          affectedPage=target.id;
        }
        break;
      }
      case 'bindAction': {const b=byId(page(op.pageId).blocks,op.blockId,'块'); addUnique(b.actions,asAction(obj(op.action,'action'))); break;}
      case 'createCollection': {
        const v=op.collection ?? op, fs:Field[]=[];
        for(const f of list(v.fields ?? [],'fields')) addUnique(fs,asField(f));
        const id=localId(v.id),reg=one(db,'SELECT space_id FROM space_collections WHERE id=?',id);
        if(reg) fail(409,'集合 ID 已使用');
        addUnique(s.collections,{id,name:str(v.name,'collection.name'),fields:fs}); break;
      }
      case 'updateCollection':
        collection(op.collectionId).name=str(op.name,'collection.name');
        break;
      case 'addField': addUnique(collection(op.collectionId).fields,asField(obj(op.field,'field'))); break;
      case 'updateField': {
        const c=collection(op.collectionId),f=byId(c.fields,op.fieldId,'字段'),replacement=asField({...f,...obj(op.field,'field'),id:f.id});
        if(f.type!==replacement.type || JSON.stringify(f.options)!==JSON.stringify(replacement.options)){
          for(const e of readEntries(db,c.id)){
            const values={...(migrated.get(e.id)?.values ?? e.values)};
            if(values[f.id]==null) continue;
            if(f.type!==replacement.type) {
              if(!op.migration || !Object.hasOwn(op.migration,e.id)) fail(409,'字段迁移需要为每个现有条目指定新值');
              values[f.id]=op.migration[e.id];
            } else if(op.migration && Object.hasOwn(op.migration,e.id)){
              values[f.id]=op.migration[e.id];
            }
            valueOk(values[f.id],replacement,h);
            if(JSON.stringify(values[f.id])!==JSON.stringify(e.values[f.id])) {
              revision(e.revision,op.entryRevisions?.[e.id],visibleEntry(e,new Map(c.fields.map(f=>[f.id,f.type])),h));
              migrated.set(e.id,{id:e.id,values});
            }else migrated.delete(e.id);
          }
        }
        c.fields[c.fields.indexOf(f)]=replacement; break;
      }
      case 'toggleModule': {
        if(!moduleTypes.some(x=>x.type===op.type) || typeof op.enabled!=='boolean') fail(400,'未知模块或无效状态');
        s.disabledModules=s.disabledModules.filter(x=>x!==op.type);
        if(!op.enabled) s.disabledModules.push(op.type);
        break;
      }
      default: fail(400,`未知空间操作 ${op.op}`);
    }
    summary.push(op.op);
    if(typeof affectedPage==='string') affectedPages.push(affectedPage);
  }
  const oldBlocks=new Map(space.structure.pages.flatMap(p=>p.blocks).map(b=>[b.id,b]));
  const objectIds=new Set<string>();
  for(const p of s.pages) for(const b of p.blocks) {
    const old=oldBlocks.get(b.id);
    for(const id of [b.id,...b.actions.map(a=>a.id)]) {
      if(objectIds.has(id)) fail(409,'块或动作 ID 重复');
      objectIds.add(id);
    }
    if(b.type==='collection') {
      const c=collection(b.config.collectionId);
      validateView(c,b.config);
      const filter=b.config.filter;
      if (filter && (old?.config.collectionId!==c.id || JSON.stringify(old.config.filter)!==JSON.stringify(filter))) {
        const f=byId(c.fields,filter.fieldId,'视图字段');
        valueOk(filter.value,f,h);
      }
    }
    for (const [key,kind] of [['sourceId','source'],['attachmentId','attachment']] as const) {
      if (b.config[key]!=null && b.config[key]!==old?.config[key]) requireReference(h,kind,str(b.config[key],key));
    }
    for(const a of b.actions) {
      if(a.params.sourceId && a.params.sourceId!==old?.actions.find(x=>x.id===a.id)?.params.sourceId) {
        requireReference(h,'source',a.params.sourceId);
      }
      if(a.params.collectionId) collection(a.params.collectionId);
    }
  }
  const pageId=affectedPages.findLast(id=>s.pages.some(p=>p.id===id)) ?? s.pages[0].id;
  return {structure:s,summary,migrated,pageId};
}
function validateView(c:Collection,config:any) {
  for(const id of [config.groupBy,config.sort?.fieldId,config.filter?.fieldId].filter(x=>x!=null)) byId(c.fields,id,'视图字段');
  if(config.sort && !['asc','desc'].includes(config.sort.direction ?? 'asc')) fail(400,'无效排序方向');
  if(config.view && !['list','table'].includes(config.view)) fail(400,'无效集合视图');
}
function visibleBlock(b:Block,collections:Collection[],h:Hooks) {
  const config={...b.config};
  const hiddenSource=config.sourceId!=null && (typeof config.sourceId!=='string' || !h.canReference('source',config.sourceId.trim()));
  if (hiddenSource) delete config.sourceId;
  if (config.attachmentId!=null && (typeof config.attachmentId!=='string' || !h.canReference('attachment',config.attachmentId.trim()))) delete config.attachmentId;
  if (config.filter) {
    const field=collections.find(c=>c.id===config.collectionId)?.fields.find(f=>f.id===config.filter.fieldId);
    const value=config.filter.value,visible=visibleValue(value,field?.type ?? '',h);
    if (visible===undefined || (Array.isArray(value) && value.length!==visible?.length)) delete config.filter;
  }
  const actions=b.actions.filter(a=>a.type!=='openSource' || (a.params.sourceId ? h.canReference('source',a.params.sourceId.trim()) : !hiddenSource));
  return {...b,config,actions};
}
function visibleSpace(s:Space,h:Hooks) {
  const {structure}=s;
  const pages=structure.pages.map(p=>({...p,blocks:p.blocks.map(b=>visibleBlock(b,structure.collections,h))}));
  return {...s,structure:{...structure,pages}};
}
function entriesView(db:DB,space:Space,c:Collection,config:any,h:Hooks) {
  validateView(c,config);
  const entries=readEntries(db,c.id),types=entryFields(db,space,c,entries);
  let items=entries.map(e=>visibleEntry(e,types,h));
  if(config.filter) items=items.filter(e=>e.values[config.filter.fieldId]===config.filter.value);
  if(config.sort) {
    const k=config.sort.fieldId,sign=config.sort.direction==='desc'?-1:1;
    items.sort((a,b)=>{const l=a.values[k]??'',r=b.values[k]??'';return sign*(typeof l==='number' && typeof r==='number'?l-r:String(l).localeCompare(String(r),'zh-Hans'));});
  }
  if(!config.groupBy) return {items};
  const groups=new Map<string,any[]>();
  for(const e of items){ const key=String(e.values[config.groupBy]??''); if(!groups.has(key)) groups.set(key,[]); groups.get(key)!.push(e); }
  return {items,groups:Array.from(groups,([value,entries])=>({value,items:entries}))};
}
function saveRevision(db:DB,s:Space,structure:Structure){
  const n=s.revision+1, json=JSON.stringify(structure);
  run(db,'UPDATE spaces SET revision=?,structure=? WHERE id=?',n,json,s.id);
  run(db,'INSERT INTO space_revisions VALUES(?,?,?,?)',s.id,n,json,now());
  for(const c of structure.collections) run(db,'INSERT OR IGNORE INTO space_collections VALUES(?,?)',c.id,s.id);
  return {...s,revision:n,structure};
}
function restoreSpace(db:DB,s:Space,h:Hooks,b:any){
  revision(s.revision,b.expectedRevision,visibleSpace(s,h));
  const target=b.targetRevision ?? b.revision;
  if(!Number.isInteger(target)) fail(400,'需要 targetRevision');
  const scope=b.scope??'layout',mode=b.mode??'apply';
  if(!['layout','structure'].includes(scope)||!['preview','apply'].includes(mode))fail(400,'无效的恢复范围或模式');
  const row=one(db,'SELECT structure FROM space_revisions WHERE space_id=? AND revision=?',s.id,target);
  if(!row)fail(404,'空间修订不存在');
  const structure:Structure=parse(row.structure);
  const conflicts:{collectionId:string,entryId:string,entryRevision:number,fieldId:string}[]=[], migrations:Migration[]=[];
  const summary:string[]=[];
  if(scope==='layout'){
    const previous=structure.collections;
    structure.collections=s.structure.collections;
    for(const page of structure.pages) {
      page.blocks=page.blocks.filter(block=>{
        const live=structure.collections.find(c=>c.id===block.config.collectionId);
        if(block.type==='collection'&&!live){summary.push('跳过已归档集合的视图');return false;}
        const old=previous.find(c=>c.id===live?.id);
        if(live)for(const [option,id] of [['groupBy',block.config.groupBy],['sort',block.config.sort?.fieldId],['filter',block.config.filter?.fieldId]]){
          if(!id)continue;
          const f=live.fields.find(f=>f.id===id && f.type===old?.fields.find(x=>x.id===id)?.type);
          try {
            if(!f)throw Error();
            if(option==='filter')valueOk(block.config.filter.value,f);
          }catch{
            delete block.config[option];summary.push('移除不兼容的历史视图设置');
          }
        }
        block.actions=block.actions.filter(a=>!a.params.collectionId||structure.collections.some(c=>c.id===a.params.collectionId));
        return true;
      });
    }
  }else{
    const replacements=obj(b.migrations??{},'migrations');
    for(const c of structure.collections){
      const entries=readEntries(db,c.id),types=entryFields(db,s,s.structure.collections.find(x=>x.id===c.id)??{...c,fields:[]},entries);
      for(const e of entries){
        const edits=replacements[e.id], values={...e.values};
        let changed=false;
        for(const f of c.fields) {
          if(Object.hasOwn(edits??{},f.id)){
            valueOk(edits[f.id],f,h);
            values[f.id]=edits[f.id];changed=true;continue;
          }
          if(values[f.id]==null)continue;
          try {
            if(types.has(f.id)&&types.get(f.id)!==f.type)throw Error();
            valueOk(values[f.id],f);
          }catch { conflicts.push({collectionId:c.id,entryId:e.id,entryRevision:e.revision,fieldId:f.id}); }
        }
        if(changed) {
          if(JSON.stringify(values)!==JSON.stringify(e.values)) {
            revision(e.revision,b.entryRevisions?.[e.id],visibleEntry(e,types,h));
          }
          migrations.push({id:e.id,values});
        }
      }
    }
  }
  const details={mode,scope,summary:[...new Set(summary)],conflicts,migratedEntries:migrations.length};
  if(mode==='preview')return {...visibleSpace({...s,structure},h),...details};
  if(conflicts.length)fail(409,'现有条目需要转换后才能恢复历史字段定义',details);
  for(const e of migrations)run(db,'UPDATE collection_entries SET value_json=?,revision=revision+1,updated_at=? WHERE id=?',JSON.stringify(e.values),now(),e.id);
  return {...visibleSpace(saveRevision(db,s,structure),h),...details};
}
export function spaceApi(db:DB,ctx:Context,scope:(projectId:string|null)=>Hooks):any {
  const {path,method,principal:p,query:q}=ctx,b=ctx.body ?? {};
  const [,area,id,action,itemId]=path.split('/').map(part=>{
    try{return decodeURIComponent(part);}catch{fail(400,'无效 URL 编码');}
  });
  if(path==='/modules' && method==='GET') return {items:moduleTypes};
  if(path==='/spaces' && method==='POST') return createSpace(db,p,b);
  if(path==='/spaces' && method==='GET') return {items:rows(db,'SELECT id,project_id FROM spaces').filter(r=>p.owner || p.projects.includes(r.project_id)).map(r=>visibleSpace(getSpace(db,p,r.id),scope(r.project_id)))};
  if(area==='spaces' && id) {
    const s=getSpace(db,p,id),h=scope(s.projectId);
    if(!action && method==='GET') return visibleSpace(s,h);
    if(action==='pages' && method==='GET') {
      const {structure}=visibleSpace(s,h);
      return {spaceId:id,projectId:s.projectId,revision:s.revision,page:byId(structure.pages,itemId,'页面'),collections:structure.collections,theme:structure.theme,cover:structure.cover,disabledModules:structure.disabledModules};
    }
    if(action==='changes' && method==='POST'){
      revision(s.revision,b.expectedRevision,visibleSpace(s,h));
      if(!['preview','apply'].includes(b.mode)) fail(400,'需要 preview 或 apply 模式');
      const ops=list(b.operations,'operations');
      if(!ops.length) fail(400,'缺少结构操作');
      const result=editStructure(db,s,ops,h);
      const change=b.mode==='preview'?{...s,structure:result.structure}:saveRevision(db,s,result.structure);
      if(b.mode==='apply') for(const e of result.migrated.values()) run(db,'UPDATE collection_entries SET value_json=?,revision=revision+1,updated_at=? WHERE id=?',JSON.stringify(e.values),now(),e.id);
      return {...visibleSpace(change,h),mode:b.mode,pageId:result.pageId,summary:result.summary,migratedEntries:result.migrated.size};
    }
    if(action==='restore' && method==='POST')return restoreSpace(db,s,h,b);
    if(action==='actions' && method==='POST'){
      const binding=s.structure.pages.flatMap(x=>x.blocks).flatMap(block=>block.actions.map(action=>({block,action}))).find(x=>x.action.id===itemId);
      if(!binding) fail(404,'动作不存在');
      if(s.structure.disabledModules.includes(binding.block.type)) fail(409,'模块已停用');
      const a=binding.action;
      switch(a.type){
        case 'openSource': return h.openSource(str(a.params.sourceId ?? binding.block.config.sourceId ?? b.sourceId,'sourceId'));
        case 'writeHandoff': return h.writeHandoff({body:b.body,sourceId:b.sourceId,refs:b.refs,extra:b.extra,confirmation:b.confirmation});
        case 'addEntry': return putEntry(db,s,byId(s.structure.collections,a.params.collectionId ?? binding.block.config.collectionId,'集合'),b,h);
      }
    }
  }
  if(area==='collections' && action==='entries'){
    const {space,c}=collectionFor(db,p,id,method==='GET'),h=scope(space.projectId);
    if(method==='GET' && !itemId) {
      const blockId=q.get('blockId');
      const block=blockId?byId(space.structure.pages.flatMap(p=>p.blocks),blockId,'块'):null;
      const view=block?visibleBlock(block,space.structure.collections,h).config:{};
      if(blockId && view.collectionId!==id) fail(400,'视图绑定了不同集合');
      return entriesView(db,space,c,view,h);
    }
    if(method==='POST' && !itemId || method==='PATCH' && itemId) return putEntry(db,space,c,b,h,itemId);
  }
}
