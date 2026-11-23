import { readFileSync } from 'node:fs'
const [file,method='GET',path,body]=process.argv.slice(2)
if(!file||!path||!path.startsWith('/')||path.startsWith('//'))throw Error('用法：node project-api.ts 凭据文件 GET|POST|PATCH|DELETE /资源路径 [JSON 或 - 从 stdin 读]')
const {baseUrl,token}=JSON.parse(readFileSync(file,'utf8'))
const base=new URL(baseUrl),target=new URL(base.href.replace(/\/$/,'')+path)
if(target.origin!==base.origin||!target.pathname.startsWith('/api/v1/'))throw Error('路径越界')
const raw=body==='-'?readFileSync(0,'utf8'):body
if(raw) JSON.parse(raw)
const response=await fetch(target,{method,redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:raw})
console.log(await response.text())
if(!response.ok)process.exitCode=1
