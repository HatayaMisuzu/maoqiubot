import type { DatabaseSync } from 'node:sqlite'
import { changed,fail,must,one,required } from '../db/index.ts'
import { resetChatContext } from '../home/visibility.ts'

export function projectWorkspaces(db:DatabaseSync,key:string,method:string,b:any){
  must(db,'SELECT id FROM projects WHERE id=?',key)
  if(method==='POST'){
    const instance=must(db,'SELECT * FROM instances WHERE id=?',required(b.instanceId,'instanceId'))
    if(instance.adapterKey==='model-api'){
      if(b.workspaceRef||b.allowAgentAccess)fail('API 工作 Bot 只登记项目范围，无本机执行目录或项目凭据',409)
    }else if(required(b.workspaceRef,'workspaceRef')!==instance.workspaceRef)fail('执行实例的工作区与选择不一致',409)
    if(b.allowAgentAccess!==undefined&&typeof b.allowAgentAccess!=='boolean')fail('allowAgentAccess 须为布尔值')
    const permission=b.agentPermission??'read',allow=b.allowAgentAccess===true?1:0
    if(!['read','append','manage'].includes(permission))fail('无效的运行资料权限')
    const old=one(db,'SELECT allowAgentAccess,agentPermission FROM project_workspaces WHERE projectId=? AND instanceId=?',key,instance.id)
    db.prepare(`INSERT INTO project_workspaces(projectId,instanceId,allowAgentAccess,agentPermission) VALUES(?,?,?,?)
      ON CONFLICT(projectId,instanceId) DO UPDATE SET allowAgentAccess=excluded.allowAgentAccess,agentPermission=excluded.agentPermission`)
      .run(key,instance.id,allow,permission)
    db.prepare('DELETE FROM run_grants WHERE projectId=? AND instanceId=? AND (?=0 OR permission<>?)').run(key,instance.id,allow,permission)
    if(old&&(old.allowAgentAccess!==allow||old.agentPermission!==permission))resetChatContext(db,key)
    changed(db,'home',{projectId:key,path:'/projects/'+key+'/workspaces'})
  }
  if(method==='DELETE'){
    const instanceId=required(b.instanceId,'instanceId')
    const removed=db.prepare('DELETE FROM project_workspaces WHERE projectId=? AND instanceId=?').run(key,instanceId)
    db.prepare('DELETE FROM run_grants WHERE projectId=? AND instanceId=?').run(key,instanceId)
    if(removed.changes)resetChatContext(db,key)
    changed(db,'home',{projectId:key,path:'/projects/'+key+'/workspaces'})
  }
  return {items:db.prepare(`SELECT i.id AS instanceId,i.name,i.nodeId,i.profileId,i.workspaceRef,p.allowAgentAccess,p.agentPermission
    FROM project_workspaces p JOIN instances i ON i.id=p.instanceId WHERE p.projectId=? ORDER BY i.name`).all(key)}
}
