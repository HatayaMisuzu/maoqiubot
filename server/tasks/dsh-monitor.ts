import { lstatSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export type DshMonitorDatabase = {
  databasePath:string
  instances:{id:string;runtimeScopeId:string}[]
}

const receiptLimit=20_000

export function dshSessionUsage(db:DatabaseSync,sources:DshMonitorDatabase[],from:Date) {
  if(!sources.length)return {rows:[],truncated:false}
  const groups=new Map<string,{
    day:string; adapterKey:'dsh'; instanceId:string; model:string; source:'dsh_session'; reportedRuns:number;
    inputTokens:number; outputTokens:number; totalTokens:number; inputCoverage:number; outputCoverage:number; totalCoverage:number
  }>()
  const bindings=db.prepare(`SELECT t.sessionId,i.id AS instanceId,i.runtimeScopeId FROM threads t JOIN instances i ON i.id=t.instanceId
    WHERE i.nodeId='local' AND i.adapterKey='dsh' AND i.runtimeScopeId IS NOT NULL AND t.sessionId IS NOT NULL
      AND t.state IN ('active','archived') AND t.nativeReleased=0 AND t.nativeInvalid IS NULL`).all()
  const matched=new Map<string,{owner:string;model:string;day:string;input:number;output:number}|null>()
  let truncated=false
  for(const {databasePath,instances} of sources) {
    const expected=new Map(instances.map(instance=>[instance.id,instance.runtimeScopeId]))
    const sessionOwners=new Map<string,string|null>()
    for(const {instanceId,runtimeScopeId,sessionId} of bindings) {
      const owner=String(instanceId),session=String(sessionId)
      if(!session||expected.get(owner)!==runtimeScopeId)continue
      const prior=sessionOwners.get(session)
      sessionOwners.set(session,prior===undefined||prior===owner ? owner : null)
    }
    const sessions=[...sessionOwners].filter(([,owner])=>owner!==null).map(([session])=>session)
    if(!sessions.length)continue

    // The companion indexes one fixed DSH home per database. Read only upstream request receipts for bound session IDs.
    let native:DatabaseSync|undefined
    try {
      if(!lstatSync(databasePath,{throwIfNoEntry:false})?.isFile())continue
      native=new DatabaseSync(databasePath,{readOnly:true})
      native.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=100')
      const rows=native.prepare(`SELECT request_id,session_id,model,strftime('%Y-%m-%d',created_at,'unixepoch','localtime') AS day,
          input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens
        FROM proxy_request_logs WHERE app_type='dsh' AND data_source='dsh_session' AND created_at>=?
          AND session_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC LIMIT ?`)
        .all(Math.floor(from.valueOf()/1000),JSON.stringify(sessions),receiptLimit+1)
      truncated ||= rows.length>receiptLimit
      for(const row of rows.slice(0,receiptLimit)){
        const owner=sessionOwners.get(String(row.session_id))
        if(!owner||typeof row.request_id!=='string'||typeof row.model!=='string'||typeof row.day!=='string')continue
        const previous=matched.get(row.request_id)
        if(previous!==undefined){
          if(previous&&previous.owner!==owner)matched.set(row.request_id,null)
          continue
        }
        const counts=[row.input_tokens,row.output_tokens,row.cache_read_tokens??0,row.cache_creation_tokens??0]
        if(!counts.every(value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=1e10))continue
        const [fresh,output,read,creation]=counts as number[]
        matched.set(row.request_id,{owner,model:row.model.slice(0,256),day:row.day,input:fresh+read+creation,output})
      }
    } catch {
      // The companion may still be initializing or updating this index. A later refresh can read it.
    } finally { native?.close() }
  }
  for(const receipt of matched.values()){
    if(!receipt)continue
    const {owner,model,day,input,output}=receipt
    const key=JSON.stringify([owner,model,day])
    const group=groups.get(key)??{day,adapterKey:'dsh',instanceId:owner,model,source:'dsh_session',reportedRuns:0,
      inputTokens:0,outputTokens:0,totalTokens:0,inputCoverage:0,outputCoverage:0,totalCoverage:0}
    group.reportedRuns++
    group.inputCoverage++
    group.outputCoverage++
    group.totalCoverage++
    group.inputTokens+=input
    group.outputTokens+=output
    group.totalTokens+=input+output
    groups.set(key,group)
  }
  return {rows:[...groups.values()],truncated}
}
