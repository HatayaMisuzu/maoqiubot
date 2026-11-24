import type { DatabaseSync } from 'node:sqlite'
import { changed,fail,id,must,required,transaction } from '../db/index.ts'
import { message } from '../tasks/index.ts'

type Fraction={n:bigint;d:bigint}
function fraction(n:bigint,d:bigint):Fraction{
  if(!d)fail('除数不能为零')
  if(d<0n){n=-n;d=-d}
  let a=n<0n?-n:n,b=d
  while(b){const rest=a%b;a=b;b=rest}
  return {n:n/a,d:d/a}
}
export function calculate(input:string){
  if(typeof input!=='string'||input.length>180)fail('计算表达式最多 180 个字符')
  const tokens=input.match(/\d+(?:\.\d+)?|[+*/()-]|[^\s]/g)??[]
  let pos=0
  function atom():Fraction{
    const token=tokens[pos++]
    if(token==='+'||token==='-'){const v=atom();return token==='-'?{n:-v.n,d:v.d}:v}
    if(token==='('){
      const v=expression()
      if(tokens[pos++]!==')')fail('表达式缺少右括号')
      return v
    }
    if(!/^\d+(?:\.\d+)?$/.test(token??''))fail('仅支持小数、括号和四则运算')
    const [whole,decimals='']=token.split('.')
    return fraction(BigInt(whole+decimals),10n**BigInt(decimals.length))
  }
  function product(){
    let value=atom()
    while(tokens[pos]==='*'||tokens[pos]==='/'){
      const op=tokens[pos++],right=atom()
      value=op==='*'?fraction(value.n*right.n,value.d*right.d):fraction(value.n*right.d,value.d*right.n)
    }
    return value
  }
  function expression(){
    let value=product()
    while(tokens[pos]==='+'||tokens[pos]==='-'){
      const op=tokens[pos++],right=product(),delta=value.d*right.n
      value=fraction(value.n*right.d+(op==='+'?delta:-delta),value.d*right.d)
    }
    return value
  }
  const {n,d}=expression()
  if(pos!==tokens.length)fail('表达式含未识别的部分')
  const abs=n<0n?-n:n
  let remainder=abs%d,decimals=''
  while(remainder&&decimals.length<30){remainder*=10n;decimals+=String(remainder/d);remainder%=d}
  const decimal=(n<0n?'-':'')+String(abs/d)+(decimals?'.'+decimals:'')
  return {value:decimal,exact:!remainder,fraction:d===1n?String(n):n+'/'+d}
}

export function listDaily(db:DatabaseSync,projectId:string|null,kind?:unknown){
  return db.prepare(`SELECT * FROM daily_items WHERE projectId IS ? AND (? IS NULL OR kind=?)
    ORDER BY state='open' DESC, dueAt IS NULL, dueAt, rowid DESC LIMIT 100`).all(projectId,kind?String(kind):null,kind?String(kind):null)
}
export function dailyAction(db:DatabaseSync,thread:any,b:any){
  if(b.action==='list')return {items:listDaily(db,thread.projectId,b.kind)}
  if(!['create','update','complete','cancel','delete'].includes(b.action))fail('事项操作无效')
  const previous=b.action==='create'?null:must(db,'SELECT * FROM daily_items WHERE id=? AND projectId IS ?',required(b.id,'事项 ID'),thread.projectId)
  if(previous&&b.expectedRevision!==previous.revision)fail('事项已变化，请读取当前版本后重试',409)
  const kind=previous?.kind??b.kind
  if(!['todo','reminder'].includes(kind))fail('请选择事项或提醒')
  const key=previous?.id??id()
  const body=required(b.body??previous?.body,'事项内容')
  if(body.length>600)fail('事项内容最多 600 个字符')
  let dueAt=previous?.dueAt??null
  if(b.dueAt!==undefined){
    if(typeof b.dueAt!=='string'||!/(?:Z|[+-]\d\d:\d\d)$/.test(b.dueAt)||!Number.isFinite(Date.parse(b.dueAt)))
      fail('提醒时间需使用含时区的 ISO 时间')
    dueAt=new Date(b.dueAt).toISOString()
  }
  if(kind==='reminder'&&(!dueAt||!previous&&Date.parse(dueAt)<=Date.now()))fail('新的提醒须指定未来时间')
  if(b.action==='delete'){
    db.prepare('DELETE FROM daily_items WHERE id=?').run(key)
    changed(db,'daily',{threadId:thread.id,id:key})
    return {id:key,state:'deleted'}
  }
  const state=b.action==='complete'?'done':b.action==='cancel'?'cancelled':
    b.action==='update'&&b.dueAt!==undefined?'open':previous?.state??'open'
  db.prepare(`INSERT INTO daily_items VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET
    body=excluded.body,dueAt=excluded.dueAt,state=excluded.state,revision=daily_items.revision+1`).run(
      key,thread.projectId,thread.id,kind,body,dueAt,state)
  changed(db,'daily',{threadId:thread.id,id:key})
  return must(db,'SELECT * FROM daily_items WHERE id=?',key)
}
export function dueReminders(db:DatabaseSync,notify?:(text:string)=>void){
  const due=db.prepare("SELECT * FROM daily_items WHERE kind='reminder' AND state='open' AND dueAt<=? ORDER BY dueAt LIMIT 20")
    .all(new Date().toISOString())
  if(!due.length)return
  transaction(db,()=>{
    for(const item of due){
      db.prepare("UPDATE daily_items SET state='fired',revision=revision+1 WHERE id=?").run(item.id)
      message(db,String(item.threadId),'assistant','reminder','提醒到期 · '+item.body,{reminderId:item.id,dueAt:item.dueAt})
    }
  })
  for(const item of due){try{notify?.(String(item.body))}catch{}}
}
