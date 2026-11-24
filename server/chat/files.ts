import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fail } from '../db/index.ts'

const secrets=/^(?:\.git|\.env(?:\..*)?|\.ssh|\.codex|\.dsh.*|node_modules|.*(?:secret|credential|token|auth|api[-_]?key|password|私钥|密钥).*|chat-model-keys\.json|project\.json)$/i
const textExtensions=new Set(['.txt','.md','.csv','.tsv','.log','.rst'])
const inside=(root:string,path:string)=>{
  const rel=relative(root,path)
  return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)
}
const hasSecretPath=(p:string)=>p.split(/[\\/]+/).some(part=>secrets.test(part))
export function allowedRoot(raw:string,dataDir:string){
  if(!isAbsolute(raw)||/^\\\\/.test(raw)||hasSecretPath(raw))fail('资料目录须为本机普通目录')
  const actual=realpathSync(raw)
  const appData=realpathSync(dataDir)
  if(hasSecretPath(actual)||!statSync(actual).isDirectory()||inside(actual,appData)||inside(appData,actual))
    fail('资料根目录不能包含工作台数据、登录目录或秘密文件目录')
  return actual
}
export function localFiles(root:string,input:string,action:'list'|'read'|'write',text?:string){
  const parts=input.split(/[\\/]+/)
  if(isAbsolute(input)||parts.some(p=>p==='..'||p.endsWith('.')||p.endsWith(' ')||/[:*?<>|"\0]/.test(p)||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))||hasSecretPath(input))fail('文件路径越出授权范围',403)
  const dest=resolve(root,input),base=action==='write'?dirname(dest):dest
  if(!inside(root,dest)||!inside(root,realpathSync(base)))fail('文件路径越出授权范围',403)
  let cursor=root
  for(const part of relative(root,base).split(sep).filter(Boolean)){
    cursor=resolve(cursor,part)
    if(lstatSync(cursor).isSymbolicLink())fail('资料路径不能经过符号链接或 junction',403)
  }
  if(action==='list'){
    return {root,path:input,items:readdirSync(dest,{withFileTypes:true}).filter(f=>!secrets.test(f.name)&&!f.isSymbolicLink()&&
      (f.isDirectory()||f.isFile()&&textExtensions.has(extname(f.name).toLowerCase()))).slice(0,100).map(f=>({name:f.name,directory:f.isDirectory()}))}
  }
  if(!textExtensions.has(extname(dest).toLowerCase()))fail('轻量工具只处理 TXT、Markdown、CSV 等文本资料',403)
  if(action==='write'){
    if(typeof text!=='string'||Buffer.byteLength(text)>64*1024||text.includes('\0'))fail('文本须在 64 KiB 以内')
    writeFileSync(dest,text,{flag:'wx',mode:0o600})
    return {root,path:input,bytes:Buffer.byteLength(text)}
  }
  const file=statSync(dest)
  if(!file.isFile()||file.size>64*1024)fail('文件过大或不是普通文本文件')
  const content=readFileSync(dest,'utf8')
  if(content.includes('\0'))fail('不支持二进制文件')
  return {root,path:input,bytes:file.size,text:content.slice(0,12000)}
}
