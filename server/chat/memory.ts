import type { DatabaseSync } from 'node:sqlite'
import { changed,fail,id,must,normalizeFactKey,now,owner,required } from '../db/index.ts'
import { homeApi,memoryFact } from '../home/index.ts'

const types=['preference','note','decision','requirement']
const sensitive=/password|api[-_ ]?key|access token|private key|密码|密钥|令牌|私钥|\b(?:sk|ghp|xoxb)[-_][a-z0-9_-]{12,}/i

export function saveUserMemory(db:DatabaseSync,dir:string,thread:any,input:any){
  const body=required(input.body,'记忆内容'),type=input.type??'preference'
  if(!types.includes(type)||body.length>5000)fail('记忆内容或分类无效')
  const factKey=input.factKey?normalizeFactKey(required(input.factKey,'事实键')):null
  if(factKey&&factKey.length>120)fail('事实键过长')
  const prior=factKey?memoryFact(db,thread.projectId,type,factKey):undefined
  const context={query:new URLSearchParams(),principal:owner,dataDir:dir}
  const fields={projectId:thread.projectId,type,body,factKey,validUntil:input.validUntil,confirmation:'user',author:'用户',
    extra:{...prior?.extra,memory:true,important:input.important===true,threadId:thread.id,messageId:input.messageId}}
  const saved=prior?homeApi(db,{...context,method:'PATCH',path:'/records/'+prior.id,body:{...fields,expectedRevision:prior.revision}}):
    homeApi(db,{...context,method:'POST',path:'/records',body:fields})
  changed(db,'home',{path:'/records/'+saved.id,projectId:thread.projectId})
  return saved
}
export function offerMemory(db:DatabaseSync,thread:any,current:any,value:unknown){
  if(!value||typeof value!=='object'||current.data?.communication?.sender?.kind!=='user')return
  const v=value as {body?:unknown;factKey?:unknown;type?:unknown;important?:unknown}
  const body=typeof v.body==='string'?v.body.trim():''
  const key=typeof v.factKey==='string'?normalizeFactKey(v.factKey):null
  const type=v.type??'preference'
  if(body.length<3||body.length>480||(key?.length??0)>120||sensitive.test(body+' '+(key??''))||!current.text.includes(body)||!types.includes(String(type)))return
  const existing=key?memoryFact(db,thread.projectId,String(type),key):undefined
  if(existing?.body===body)return
  const keyId=id()
  const result=db.prepare(`INSERT OR IGNORE INTO memory_candidates VALUES(?,?,?,?,?,?,?,?, 'pending',?)`).run(
    keyId,thread.id,current.id,thread.projectId,body,key,String(type),v.important===true?1:0,now())
  if(result.changes)changed(db,'memory_candidate',{threadId:thread.id,id:keyId})
  return result.changes?{id:keyId,status:'pending'}:undefined
}
export function memoryCandidates(db:DatabaseSync,thread:any){
  return db.prepare(`SELECT c.*,m.text AS original FROM memory_candidates c JOIN messages m ON m.id=c.messageId
    WHERE c.projectId IS ? AND c.status='pending' ORDER BY c.rowid DESC LIMIT 50`).all(thread.projectId)
}
export function reviewMemory(db:DatabaseSync,dir:string,thread:any,b:any){
  if(!['accept','reject'].includes(b.action))fail('记忆候选操作无效')
  const candidate=must(db,"SELECT * FROM memory_candidates WHERE id=? AND projectId IS ? AND status='pending'",
    required(b.id,'记忆候选 ID'),thread.projectId)
  const saved=b.action==='accept'?saveUserMemory(db,dir,{id:candidate.threadId,projectId:thread.projectId},{
    body:b.body??candidate.body,factKey:b.factKey??candidate.factKey,type:candidate.recordType,
    important:Boolean(candidate.important),messageId:candidate.messageId}):undefined
  db.prepare('UPDATE memory_candidates SET status=? WHERE id=?').run(b.action==='accept'?'accepted':'rejected',candidate.id)
  changed(db,'memory_candidate',{threadId:thread.id,id:candidate.id})
  return {id:candidate.id,recordId:saved?.id,status:b.action==='accept'?'accepted':'rejected'}
}
