import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, id } from '../db/index.ts'

const defaultPersona='你叫小毛球。用中文自然交流，语气温和直接。能简洁说明时优先简洁，需要做选择时说清依据与不确定性。'
const limit=4000

export function persona(dir:string){
  try{
    const text=readFileSync(join(dir,'persona.md'),'utf8').trim().slice(0,limit)
    if(text)return {text,source:'custom' as const}
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
  return {text:defaultPersona,source:'default' as const}
}

export function savePersona(dir:string,b:any){
  const path=join(dir,'persona.md')
  if(b.reset===true){rmSync(path,{force:true});return persona(dir)}
  if(typeof b.text!=='string'||!b.text.trim()||b.text.length>limit)fail('人格文本须为 1 至 4000 字符')
  const temp=join(dir,'.persona-'+id())
  try{
    writeFileSync(temp,b.text.trim()+'\n',{mode:0o600,flag:'wx'})
    renameSync(temp,path)
  }finally{rmSync(temp,{force:true})}
  return persona(dir)
}
