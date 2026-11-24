import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { now, one, owner } from '../db/index.ts'
import type { Principal } from '../home/common.ts'

export const secret=()=>randomBytes(32).toString('base64url')
export const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const same=(a:string,b:string)=>timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)))
export function access(dir:string) {
  const file=join(dir,'access.local.json')
  try {writeFileSync(file,JSON.stringify({ownerToken:secret(),nodes:{local:secret()}},null,2),{flag:'wx',mode:0o600})}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}
  const cfg=JSON.parse(readFileSync(file,'utf8'))
  if(process.env.OWNER_TOKEN) cfg.ownerToken=process.env.OWNER_TOKEN
  if(process.env.NODE_TOKEN)cfg.nodes.local=process.env.NODE_TOKEN
  if(typeof cfg.ownerToken!=='string'||cfg.ownerToken.length<16||Object.values(cfg.nodes).some(t=>typeof t!=='string'||t.length<16))throw Error('请配置至少 16 个字符的独立访问令牌')
  if(new Set([cfg.ownerToken,...Object.values(cfg.nodes)]).size!==1+Object.keys(cfg.nodes).length)throw Error('所有者及节点令牌必须独立')
  return {cfg,node(token:string){return Object.keys(cfg.nodes).find(k=>token && same(token,cfg.nodes[k]))},
    principal(db:DatabaseSync,token:string):Principal|undefined{if(!token)return
      if(same(token,cfg.ownerToken))return owner
      const digest=hash(token)
      const communication=one(db,`SELECT g.runId FROM communication_grants g
        JOIN runs r ON r.id=g.runId JOIN threads t ON t.id=r.threadId
        WHERE g.tokenHash=? AND g.expiresAt>? AND r.taskId IS NOT NULL AND r.status IN ('queued','running','waiting_input')
          AND (t.projectId IS NULL OR EXISTS(SELECT 1 FROM project_workspaces p WHERE p.projectId=t.projectId AND p.instanceId=r.instanceId))`,digest,now())
      if(communication)return {id:'run:'+communication.runId+':communication',owner:false,projects:[],communicationOnly:true}
      const grant=one(db,'SELECT id,projectId FROM grants WHERE tokenHash=? AND (expiresAt IS NULL OR expiresAt>?)',digest,now())
      if(grant)return {id:grant.id,owner:false,projects:[grant.projectId as string]}
      const run=one(db,`SELECT g.runId,g.projectId,g.permission FROM run_grants g
        JOIN runs r ON r.id=g.runId AND r.instanceId=g.instanceId
        JOIN threads t ON t.id=r.threadId AND t.projectId=g.projectId
        JOIN project_workspaces p ON p.projectId=g.projectId AND p.instanceId=g.instanceId
        WHERE g.tokenHash=? AND g.expiresAt>? AND p.allowAgentAccess=1 AND p.agentPermission=g.permission
          AND r.status IN ('queued','running','waiting_input','cancelling')`,digest,now())
      if(run)return {id:'run:'+run.runId,owner:false,projects:[run.projectId],runPermission:run.permission}
    }}
}
