import type { DatabaseSync } from 'node:sqlite'
import { selectedModel } from '../chat/model-settings.ts'
import { apiBotNode } from './api-bots.ts'
import { dshSessionUsage } from './dsh-monitor.ts'
import type { DshMonitorDatabase } from './dsh-monitor.ts'

const localNodes=['local',apiBotNode] as const

export function agentMonitor(db:DatabaseSync,dataDir:string,options?:{days?:number},dshDatabases:DshMonitorDatabase[] = []) {
  const days=options?.days===7||options?.days===90 ? options.days : 30
  const current=new Date(), from=new Date(current)
  from.setHours(0,0,0,0)
  from.setDate(from.getDate()-days+1)

  const instances=db.prepare(`SELECT i.id, COALESCE(s.displayName,i.name) AS name, i.nodeId, i.adapterKey, i.workspaceRef,
      i.profileId,i.online,i.lastSeen,i.availableActions,i.capabilities,COALESCE(s.enabled,1) AS enabled,
      COALESCE(s.allowDirect,1) AS allowDirect,COALESCE(s.allowDelegate,1) AS allowDelegate,
      (SELECT COUNT(*) FROM runs r WHERE r.instanceId=i.id AND r.status IN ('queued','running','waiting_input','cancelling')
        AND EXISTS(SELECT 1 FROM commands c WHERE c.runId=r.id AND c.kind IN ('run','prepare'))) AS activeRuns,
      (SELECT COUNT(*) FROM runs r WHERE r.instanceId=i.id AND r.status='uncertain'
        AND EXISTS(SELECT 1 FROM commands c WHERE c.runId=r.id AND c.kind IN ('run','prepare'))) AS uncertainRuns,
      f.status AS lastFailure, f.createdAt AS lastFailureStartedAt
    FROM instances i LEFT JOIN bot_settings s ON s.instanceId=i.id
    LEFT JOIN runs f ON f.id=(SELECT r.id FROM runs r WHERE r.instanceId=i.id AND r.status IN ('failed','blocked','uncertain')
      AND EXISTS(SELECT 1 FROM commands c WHERE c.runId=r.id AND c.kind IN ('run','prepare')) ORDER BY r.rowid DESC LIMIT 1)
    WHERE i.nodeId IN (?,?) ORDER BY name,i.id`).all(...localNodes).map(row=>{
    const capabilities=JSON.parse(String(row.capabilities||'{}')) as {version?:string;usage?:boolean;error?:string}
    const isApi=row.nodeId===apiBotNode
    let model:string|null=null, configurationReady=true
    if(isApi){
      try {model=selectedModel(dataDir,String(row.profileId))?.model.model??null}
      catch {configurationReady=false}
      if(!model)configurationReady=false
    }
    const online=Boolean(row.online)&&configurationReady
    const canRun=Boolean(row.enabled)&&online&&JSON.parse(String(row.availableActions||'[]')).includes('run')
    return {
      id:String(row.id),name:row.name,adapterKey:row.adapterKey,workspaceRef:row.workspaceRef,
      profileId:row.profileId,model,online,canRun,lastSeen:isApi?null:row.lastSeen,
      version:typeof capabilities.version==='string'?capabilities.version.slice(0,160):null,
      settings:{enabled:Boolean(row.enabled),allowDirect:Boolean(row.allowDirect),allowDelegate:Boolean(row.allowDelegate)},
      usageAvailable:online&&capabilities.usage===true&&row.adapterKey==='codex'&&!isApi,
      issue:!configurationReady?'api_configuration':!online&&capabilities.error?'native_connection':null,
      activeRuns:Number(row.activeRuns),uncertainRuns:Number(row.uncertainRuns),
      lastFailure:row.lastFailure ? {status:row.lastFailure,startedAt:row.lastFailureStartedAt} : null
    }
  })

  const receipts=db.prepare(`SELECT strftime('%Y-%m-%d',u.recordedAt,'localtime') AS day, i.adapterKey, i.id AS instanceId, u.model, u.source,
      COUNT(*) AS reportedRuns, SUM(u.inputTokens) AS inputTokens, SUM(u.outputTokens) AS outputTokens, SUM(u.totalTokens) AS totalTokens,
      COUNT(u.inputTokens) AS inputCoverage, COUNT(u.outputTokens) AS outputCoverage, COUNT(u.totalTokens) AS totalCoverage
    FROM bot_usage_receipts u JOIN runs r ON r.id=u.runId JOIN instances i ON i.id=r.instanceId
    WHERE u.recordedAt>=? AND i.nodeId IN (?,?) GROUP BY day,i.adapterKey,i.id,u.model,u.source
    ORDER BY day DESC,i.adapterKey,i.id,u.model LIMIT 1001`).all(from.toISOString(),...localNodes)
  const dsh=dshSessionUsage(db,dshDatabases,from)
  const usage=[...receipts,...dsh.rows].sort((a,b)=>String(b.day).localeCompare(String(a.day))||
    String(a.instanceId).localeCompare(String(b.instanceId))||String(a.model).localeCompare(String(b.model)))
  return {instances,usage:usage.slice(0,1000),usageTruncated:dsh.truncated||usage.length>1000,days,fetchedAt:current.toISOString()}
}
