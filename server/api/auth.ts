import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { one, owner } from '../db/index.ts'

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
    principal(db:DatabaseSync,token:string){if(!token)return
      if(same(token,cfg.ownerToken))return owner
      const digest=hash(token)
      const grant=one(db,'SELECT id,projectId FROM grants WHERE tokenHash=?',digest) ?? one(db,"SELECT 'instance:' || instanceId || ':' || projectId AS id,projectId FROM run_grants WHERE tokenHash=?",digest)
      if(grant)return {id:grant.id,owner:false,projects:[grant.projectId as string]}
    }}
}
