import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const grantLifetimeMs=24*60*60*1000
const filenames=['project.json','communication.json'] as const
const directoryPattern=/^grant-(\d+)-[A-Za-z0-9]{6}$/

function grantRoot(){
  const localAppData=process.env.LOCALAPPDATA
  const userState=process.platform==='win32'
    ? localAppData&&isAbsolute(localAppData)?localAppData:join(homedir(),'AppData','Local')
    : join(homedir(),'.local','state')
  return join(userState,'xiaomaoqiu-workbench','connector-grants')
}

function missing(error:unknown){return (error as NodeJS.ErrnoException).code==='ENOENT'}
function noProcess(pid:number){
  if(!Number.isSafeInteger(pid)||pid<1||pid>0x7fffffff)return false
  try{process.kill(pid,0);return false}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'}
}

function removeKnownFiles(dir:string){
  for(const name of filenames){
    try{unlinkSync(join(dir,name))}catch(error){if(!missing(error))throw error}
  }
  try{rmdirSync(dir)}catch(error){if(!missing(error))throw error}
}

function restrictWindowsDirectory(root:string){
  const windows=process.env.SystemRoot||'C:\\Windows'
  const powershell=join(windows,'System32','WindowsPowerShell','v1.0','powershell.exe')
  const command=`$ErrorActionPreference = 'Stop'
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($sid in @($owner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($env:MAOQIU_GRANT_ACL_TARGET, $acl)`
  const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',command],{
    env:{...process.env,MAOQIU_GRANT_ACL_TARGET:root},windowsHide:true,stdio:'ignore',timeout:10_000
  })
  if(result.status!==0)throw Error('无法将 Windows 临时凭据目录限制为当前用户')
}

export function grantFiles(root=grantRoot()){
  let aclReady=false
  function assertDirectory(){
    const directory=lstatSync(root)
    if(!directory.isDirectory()||directory.isSymbolicLink()||process.platform!=='win32'&&
      (directory.uid!==process.getuid?.()||(directory.mode&0o077)!==0))throw Error('连接器凭据目录须由当前用户私有')
    if(process.platform==='win32'&&!aclReady){
      restrictWindowsDirectory(root)
      aclReady=true
    }
  }
  function sweep(now=Date.now()){
    try{assertDirectory()}catch(error){if(missing(error))return;throw error}
    for(const entry of readdirSync(root,{withFileTypes:true})){
      const match=directoryPattern.exec(entry.name)
      if(!entry.isDirectory()||!match||!noProcess(Number(match[1])))continue
      const dir=join(root,entry.name)
      try{
        const children=readdirSync(dir,{withFileTypes:true})
        const lastWrite=Math.max(lstatSync(dir).mtimeMs,...children.map(child=>lstatSync(join(dir,child.name)).mtimeMs))
        if(now-lastWrite>grantLifetimeMs&&children.every(child=>child.isFile()&&filenames.some(name=>name===child.name)))
          removeKnownFiles(dir)
      }catch(error){if(!missing(error))console.warn('连接器无法清理已过期的临时凭据')}
    }
  }
  function create(){
    mkdirSync(root,{recursive:true,mode:0o700})
    assertDirectory()
    const dir=mkdtempSync(join(root,`grant-${process.pid}-`))
    return {
      dir,
      write(name:typeof filenames[number],value:object){
        writeFileSync(join(dir,name),JSON.stringify(value),{mode:0o600,flag:'wx'})
      },
      dispose(){removeKnownFiles(dir)}
    }
  }
  return {create,sweep}
}
