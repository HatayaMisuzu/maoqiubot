import type { DatabaseSync } from 'node:sqlite'
import { fail,must,transaction } from '../db/index.ts'
import { readLocal } from './model-settings.ts'
import { message } from '../tasks/index.ts'
import type { ToolExchange } from './provider.ts'

export type HistorySource={contextRevision:number;resetVersion:number;state:string;read?:boolean}
export type ChatCheckpoint={
  steps:number;seen:string[];toolResults:unknown[];exchanges:ToolExchange[];
  softStepLimit:number;hardStepLimit:number;consecutiveFailures:number;authStamp?:string;
  historySources?:Record<string,HistorySource>
}

function toolPolicy(dir:string){
  return readLocal<{toolBudget?:number;toolHardLimit?:number}>(dir,'chat-policy.json',{})
}
export function budgetOverride(dir:string,value:any){
  if(value==null)return null
  const {toolHardLimit=100}=toolPolicy(dir)
  if(typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length||Object.keys(value).some(key=>!['softLimit','hardLimit'].includes(key)))
    fail('工具预算须包含 softLimit 或 hardLimit')
  for(const limit of Object.values(value))
    if(typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<1||limit>toolHardLimit)fail('工具预算超出当前工作台允许范围')
  if(value.softLimit!==undefined&&value.hardLimit!==undefined&&value.softLimit>value.hardLimit)fail('起始工具预算不能高于硬限')
  return {softLimit:value.softLimit,hardLimit:value.hardLimit}
}
export function initialBudget(dir:string,threadValue:string|null,turnValue:any){
  const {toolBudget=10,toolHardLimit=100}=toolPolicy(dir)
  const thread=threadValue?JSON.parse(threadValue):null
  const hard=Math.min(toolHardLimit,turnValue?.hardLimit??thread?.hardLimit??toolHardLimit)
  return emptyCheckpoint(Math.min(hard,turnValue?.softLimit??thread?.softLimit??toolBudget),hard)
}

export function emptyCheckpoint(softStepLimit:number,hardStepLimit:number):ChatCheckpoint{
  return {steps:0,seen:[],toolResults:[],exchanges:[],softStepLimit,hardStepLimit,consecutiveFailures:0}
}

export function continueBudget(db:DatabaseSync,dir:string,messageId:string,hardLimit?:number){
  const work=()=>{
    const job=must(db,"SELECT * FROM chat_jobs WHERE messageId=? AND kind='user_turn' AND status='budget_paused'",messageId)
    if(typeof job.checkpoint!=='string')fail('本轮没有可续行的工具记录',409)
    const checkpoint=JSON.parse(job.checkpoint) as ChatCheckpoint
    const ceiling=toolPolicy(dir).toolHardLimit??100
    const nextHard=hardLimit??Math.min(ceiling,checkpoint.hardStepLimit+10)
    if(!Number.isSafeInteger(nextHard)||nextHard<=checkpoint.steps||nextHard>ceiling||nextHard>100)
      fail('继续预算须高于已用次数且不超过当前工作台硬上限',409)
    checkpoint.hardStepLimit=nextHard
    checkpoint.softStepLimit=Math.min(nextHard,Math.max(checkpoint.softStepLimit,Math.min(nextHard,checkpoint.steps+10)))
    db.prepare("UPDATE chat_jobs SET status='queued',checkpoint=?,inFlight=NULL WHERE id=?")
      .run(JSON.stringify(checkpoint),job.id)
    message(db,String(job.threadId),'system','activity','已继续同一轮工具任务。已完成操作与回执保持记录。',
      {replyTo:messageId,used:checkpoint.steps,hardLimit:nextHard})
    return {jobId:job.id,messageId,used:checkpoint.steps,softLimit:checkpoint.softStepLimit,hardLimit:nextHard,status:'queued'}
  }
  return db.isTransaction?work():transaction(db,work)
}
