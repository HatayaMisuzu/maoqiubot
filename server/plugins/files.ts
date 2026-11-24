import { createHash } from 'node:crypto'
import { lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync } from 'node:fs'
import { basename,dirname,join,relative,resolve,sep,win32 } from 'node:path'
import { unzipSync } from 'fflate'
import { parse } from 'yaml'
import { fail } from '../db/index.ts'

const maxPackageBytes=8*1024*1024
export const skillName=/^[a-z0-9]+(?:-[a-z0-9]+)*$/
export function relativePath(value:string){
  if(typeof value!=='string'||value.length>220||value.includes('\\')||win32.isAbsolute(value)||
    value.split('/').some(p=>!p||p==='.'||p==='..'||/[<>:"|?*\u0000-\u001f]/.test(p)||/[. ]$/.test(p)||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)))fail('插件的相对路径无效')
  return value
}
export function packagePath(root:string,path:string){
  const clean=relativePath(path),base=realpathSync(root)
  let target=base
  for(const segment of clean.split('/')){
    target=join(target,segment)
    if(lstatSync(target).isSymbolicLink())fail('插件资源不接受链接',403)
  }
  const real=realpathSync(target)
  if(!real.startsWith(base+sep))fail('插件资源超出安装目录',403)
  return real
}
const excluded=(name:string)=>/^(?:\.git|node_modules|\.env(?:\..*)?)$/i.test(name)
export function tree(root:string){
  const base=realpathSync(root)
  const result=new Map<string,Buffer>()
  let total=0
  function visit(dir:string){
    for(const item of readdirSync(dir,{withFileTypes:true})){
      if(excluded(item.name))continue
      const path=join(dir,item.name),rel=relativePath(relative(base,path).split(sep).join('/'))
      const stat=lstatSync(path)
      if(stat.isSymbolicLink())fail('插件包不接受符号链接和目录联接')
      if(stat.isDirectory()){visit(path);continue}
      total+=stat.size
      if(!stat.isFile()||result.size>=300||total>maxPackageBytes)fail('插件包超出 300 个文件或 8 MiB')
      result.set(rel,readFileSync(path))
    }
  }
  visit(base)
  return result
}
export function fingerprint(files:Map<string,Buffer>){
  const hash=createHash('sha256')
  for(const [name,data] of [...files].sort(([a],[b])=>a<b?-1:a>b?1:0)){
    hash.update(JSON.stringify([name,data.length])).update(data)
  }
  return hash.digest('hex')
}
export function writeTree(root:string,files:Map<string,Buffer>){
  const seen=new Set<string>()
  mkdirSync(root,{recursive:true,mode:0o700})
  for(const [name,data] of files){
    if(seen.has(name.toLowerCase()))fail('插件包中存在文件名大小写冲突')
    seen.add(name.toLowerCase())
    const file=resolve(root,relativePath(name))
    mkdirSync(dirname(file),{recursive:true,mode:0o700})
    writeFileSync(file,data,{flag:'wx',mode:0o600})
  }
}
export function zipTree(data:Uint8Array){
  if(data.byteLength>maxPackageBytes)fail('插件压缩包超过 8 MiB')
  let size=0,count=0
  const files=unzipSync(data,{filter(file){
    if(file.name.endsWith('/')){relativePath(file.name.slice(0,-1));return false}
    const name=relativePath(file.name)
    if(name.split('/').some(excluded))return false
    size+=file.originalSize
    if(size>maxPackageBytes||++count>300)fail('插件解压后超过 300 个文件或 8 MiB')
    return true
  }})
  const names=Object.keys(files)
  const strip=!names.includes('plugin.json')&&names.length>0&&names.every(n=>n.split('/')[0]===names[0].split('/')[0]&&n.includes('/'))
  return new Map(names.map(name=>[strip?name.slice(name.indexOf('/')+1):name,Buffer.from(files[name])]))
}
export function readText(root:string,name:string,limit=48000){
  const path=packagePath(root,name),stat=lstatSync(path)
  if(!stat.isFile()||stat.size>limit)fail('插件文本资源超过大小限制')
  const bytes=readFileSync(path)
  if(bytes.includes(0))fail('插件资源须为文本')
  try{return new TextDecoder('utf8',{fatal:true}).decode(bytes)}catch{fail('插件资源须为 UTF-8 文本')}
}
export function skillMetadata(text:string,folder:string){
  const front=/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if(!front)fail('SKILL.md 缺少 YAML frontmatter')
  let value:Record<string,unknown>
  try{value=parse(front[1],{maxAliasCount:0})}catch{fail('SKILL.md 的 YAML 无效')}
  const name=value?.name,description=value?.description
  if(typeof name!=='string'||name.length>64||!skillName.test(name)||name!==basename(folder)||
    typeof description!=='string'||!description.trim()||description.length>1024)fail('Skill 的 name 或 description 不符合规范')
  if(value.compatibility!==undefined&&(typeof value.compatibility!=='string'||value.compatibility.length>500))fail('Skill compatibility 无效')
  if(value.metadata!==undefined&&(!value.metadata||typeof value.metadata!=='object'||Array.isArray(value.metadata)||
    Object.values(value.metadata).some(item=>typeof item!=='string')))fail('Skill metadata 必须使用字符串键值')
  return {name,description,license:typeof value.license==='string'?value.license:undefined,
    compatibility:typeof value.compatibility==='string'?value.compatibility:undefined,metadata:value.metadata}
}
