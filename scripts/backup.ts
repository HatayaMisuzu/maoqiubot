import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, copyFileSync, renameSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import {resolve,join,basename,dirname,relative,isAbsolute} from 'node:path'
import {pathToFileURL} from 'node:url'

export function transfer(source:string,destination:string,restore=false){
  const src=resolve(source),dest=resolve(destination)
  if(existsSync(dest))throw Error('目标目录必须尚未存在')
  const rel=relative(src,dest)
  if(!isAbsolute(rel)&&!rel.startsWith('..'))throw Error('请选择数据目录外的目标目录')
  if(!existsSync(join(src,'workbench.sqlite')))throw Error('源目录没有 workbench.sqlite')
  mkdirSync(dirname(dest),{recursive:true})
  const stage=mkdtempSync(join(dirname(dest),'.maoqiu-copy-'))
  try{
    const db=new DatabaseSync(join(src,'workbench.sqlite'),{readOnly:true})
    try{
      db.exec('PRAGMA busy_timeout=10000')
      db.prepare('VACUUM INTO ?').run(join(stage,'workbench.sqlite'))
    }finally{db.close()}
    const snap=new DatabaseSync(join(stage,'workbench.sqlite'),{readOnly:true})
    try{
      const check=snap.prepare('PRAGMA integrity_check').get()
      if(check?.integrity_check!=='ok'||snap.prepare('PRAGMA foreign_key_check').get())throw Error('备份数据库一致性检查失败')
      const files=snap.prepare('SELECT id,bytes FROM attachments').all()
      mkdirSync(join(stage,'attachments'))
      for(const file of files){
        const key=String(file.id)
        if(basename(key)!==key || !/^[a-zA-Z0-9_-]+$/.test(key))throw Error('附件 ID 无效')
        const target=join(stage,'attachments',key)
        copyFileSync(join(src,'attachments',key),target)
        if(statSync(target).size!==file.bytes)throw Error('附件长度不符 '+key)
      }
      if(existsSync(join(src,'access.local.json')))copyFileSync(join(src,'access.local.json'),join(stage,'access.local.json'))
    }finally{snap.close()}
    renameSync(stage,dest)
  }catch(e){rmSync(stage,{recursive:true,force:true});throw e}
  return {operation:restore?'restore':'backup',directory:dest}
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const [mode,src,dest]=process.argv.slice(2)
  if(!['save','restore'].includes(mode)||!src||!dest)throw Error('用法：npm run backup -- save|restore 源目录 新目标目录')
  console.log(transfer(src,dest,mode==='restore'))
}
