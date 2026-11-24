import type { DatabaseSync } from 'node:sqlite'
import { lstatSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { must, one, unpack } from '../db/index.ts'
import { homeRead, latestRun } from '../tasks/index.ts'
import { allowedRoot, localFiles } from './files.ts'

function within(root:string,path:string){
  const rel=relative(root,path)
  return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)
}

export function checkDelivery(db:DatabaseSync,dir:string,task:any,runId?:string,roots:string[]=[],includeExcerpt=false){
  const run=runId?must(db,'SELECT id,status,instanceId FROM runs WHERE id=? AND taskId=?',runId,task.id):latestRun(db,task.workThreadId)
  const receipts=run?db.prepare(`SELECT id,kind,data,refs FROM messages WHERE threadId=? AND json_extract(data,'$.runId')=?
    AND (kind IN ('artifact','completed','failed') OR json_extract(data,'$.type') IN ('handoff','delivery'))
    ORDER BY rowid DESC LIMIT 20`).all(task.workThreadId,run.id).map(r=>unpack(r,['data','refs'])):[]
  const paths=new Map<string,string>()
  const links=new Map<string,{type:string;id:string}>()
  for(const receipt of receipts){
    const {data,refs}=receipt
    const reported=data.delivery?.paths??data.paths
    for(const path of [receipt.kind==='artifact'?data.path:undefined,...(Array.isArray(reported)?reported.slice(0,15):[])]){
      if(typeof path==='string'&&path.length<=600&&!paths.has(path)&&paths.size<12)paths.set(path,receipt.id)
    }
    for(const ref of [...(Array.isArray(refs)?refs:[]),
      ...(Array.isArray(data.attachmentIds)?data.attachmentIds.map((id:string)=>({type:'attachment',id})):[])]){
      if(typeof ref?.id==='string'&&['attachment','source','record'].includes(ref.type)&&links.size<10)links.set(ref.type+':'+ref.id,ref)
    }
  }
  const instance=run&&one(db,'SELECT nodeId,workspaceRef FROM instances WHERE id=?',run.instanceId)
  const workspace=instance?.nodeId==='local'&&instance.workspaceRef===task.brief.workspaceRef&&isAbsolute(instance.workspaceRef)
    ?resolve(instance.workspaceRef):null
  const localRoots=workspace?roots.flatMap(root=>{
    try{return [allowedRoot(root,dir)]}catch{return []}
  }):[]
  const files=[...paths].map(([path,receiptId])=>{
    if(workspace){
      const target=resolve(workspace,path)
      for(const root of localRoots){
        if(!within(workspace,target)||!within(root,target))continue
        try{
          const file=localFiles(root,relative(root,target),'archive')
          if(!('text' in file)||typeof file.text!=='string')continue
          return {path,receiptId,status:'readable',bytes:file.bytes,
            ...(includeExcerpt?{excerpt:file.text.slice(0,500)}:{})}
        }catch{}
      }
    }
    return {path,receiptId,status:'unverified'}
  })
  const materials=[...links.values()].map(({type,id})=>{
    try{
      const item=homeRead(db,dir,'/'+type+'s/'+encodeURIComponent(id),task.projectId,'meta=1')
      if(!item||(type==='record'?item.projectId!==task.projectId:
        task.projectId?!item.projectIds?.includes(task.projectId):item.projectIds?.length||item.endpointIds?.length))return {type,id,status:'unverified'}
      if(type==='attachment'){
        const stored=lstatSync(join(dir,'attachments',item.id))
        if(!stored.isFile()||stored.size!==item.size)return {type,id,status:'unverified'}
      }
      return {type,id,status:'available',title:item.name??item.title,bytes:item.size}
    }catch{return {type,id,status:'unverified'}}
  })
  return {taskId:task.id,runId:run?.id??null,runStatus:run?.status??null,
    reportIds:receipts.filter(r=>r.kind!=='artifact').map(r=>r.id),
    files,materials,criteria:task.brief.doneWhen??[],ownerReview:run?one(db,`SELECT id FROM messages WHERE threadId=?
      AND kind='review' AND json_extract(data,'$.runId')=? ORDER BY rowid DESC LIMIT 1`,task.workThreadId,run.id)?.id??null:null}
}
