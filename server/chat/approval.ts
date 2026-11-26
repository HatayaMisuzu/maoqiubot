import type { DatabaseSync } from 'node:sqlite'
import { changed,fail,must,required,transaction } from '../db/index.ts'
import { message } from '../tasks/index.ts'
import type { ToolCall, ToolExchange } from './provider.ts'

export type Operation={id:string;tool:string;args:string;stamp:string;expires:number;approved?:boolean;call?:ToolCall;
  pluginRevision?:number;
  pluginAuthorization?:{digest:string;trustCode:boolean;allowNetwork:boolean};
  continuation?:{steps:number;seen:string[];toolResults:unknown[];exchanges:ToolExchange[]}}

export function proposeOperation(db:DatabaseSync,job:any,operation:Operation){
  db.prepare("UPDATE chat_jobs SET operation=?,status='awaiting_approval' WHERE id=?").run(JSON.stringify(operation),job.id)
  changed(db,'chat',{threadId:job.threadId,messageId:job.messageId,status:'awaiting_approval'})
}

export function resolveOperation(db:DatabaseSync,b:any){
  const messageId=required(b.messageId,'messageId')
  if(typeof b.approved!=='boolean')fail('请确认或拒绝这项操作')
  const job=must(db,"SELECT * FROM chat_jobs WHERE messageId=? AND status='awaiting_approval'",messageId)
  const operation=JSON.parse(job.operation) as Operation
  if(required(b.approvalId,'approvalId')!==operation.id)fail('确认内容已改变，请重新查看',409)
  if(operation.expires<Date.now())fail('该操作确认已过期，请重新发起',409)
  if(b.approved){
    const args=JSON.parse(operation.args) as Record<string,unknown>
    const requiresPluginAuthorization=operation.tool==='plugin_activate'||
      operation.tool==='plugin_switch'&&args.action==='rollback'
    let pluginAuthorization:Operation['pluginAuthorization']
    if(requiresPluginAuthorization){
      const submitted=b.pluginAuthorization
      if(!submitted||submitted.digest!==args.digest||typeof submitted.trustCode!=='boolean'||typeof submitted.allowNetwork!=='boolean')
        fail('插件授权须在查看版本摘要与差异后明确选择',403)
      pluginAuthorization={digest:submitted.digest,trustCode:submitted.trustCode,allowNetwork:submitted.allowNetwork}
    }
    db.prepare("UPDATE chat_jobs SET operation=?,status='queued' WHERE id=?")
      .run(JSON.stringify({...operation,approved:true,...(pluginAuthorization?{pluginAuthorization}:{})}),job.id)
  }else{
    db.prepare("UPDATE chat_jobs SET operation=NULL,status='cancelled' WHERE id=?").run(job.id)
    message(db,job.threadId,'system','activity','已拒绝这项操作',{replyTo:messageId})
  }
  const status=b.approved?'queued':'cancelled'
  changed(db,'chat',{threadId:job.threadId,messageId,status})
  return {messageId,status}
}

export function pendingChat(db:DatabaseSync,threadId:string){
  return db.prepare(`SELECT messageId,status,operation,checkpoint FROM chat_jobs WHERE threadId=?
    AND status IN ('queued','working','awaiting_approval','budget_paused') ORDER BY id`).all(threadId).map(({messageId,status,operation,checkpoint})=>{
    const data=status==='awaiting_approval'&&typeof operation==='string'?JSON.parse(operation) as Operation:null
    const budget=status==='budget_paused'&&typeof checkpoint==='string'?JSON.parse(checkpoint):null
    return {messageId,status,proposal:data?{id:data.id,tool:data.tool,arguments:JSON.parse(data.args),expires:data.expires}:undefined,
      budget:budget?{used:budget.steps,softLimit:budget.softStepLimit,hardLimit:budget.hardStepLimit}:undefined}
  })
}

export function expireApprovals(db:DatabaseSync){
  transaction(db,()=>{
    const expired=db.prepare(`UPDATE chat_jobs SET operation=NULL,status='cancelled'
      WHERE status='awaiting_approval' AND json_extract(operation,'$.expires')<=? RETURNING threadId,messageId`).all(Date.now())
    for(const {threadId,messageId} of expired){
      message(db,String(threadId),'system','activity','操作确认已过期，请重新发起。',{replyTo:messageId})
      changed(db,'chat',{threadId,messageId,status:'cancelled'})
    }
  })
}
