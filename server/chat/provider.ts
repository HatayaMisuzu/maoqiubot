import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { codexEnvironment, codexServiceArgs } from '../../contracts/codex-local.ts'

export type ChatAttachment={id:string,name:string,contentType:string,data:string}
export type ChatProvider={
  name:string
  generate(prompt:string,attachments:ChatAttachment[]):Promise<unknown>
}

export const codexChat:ChatProvider={
  name:'本机 Codex',
  async generate(prompt,attachments){
    const dir=mkdtempSync(join(tmpdir(),'maoqiu-chat-'))
    try {
      const args=['exec',...codexServiceArgs,'--ephemeral','--skip-git-repo-check','--sandbox','read-only','--color','never','--output-schema',fileURLToPath(new URL('./decision.json',import.meta.url)),'-o',join(dir,'result.json')]
      for(const [index,a] of attachments.entries()){
        if(['image/png','image/jpeg','image/webp'].includes(a.contentType)){
          const file=join(dir,'image-'+index+'.'+a.contentType.split('/')[1])
          writeFileSync(file,Buffer.from(a.data,'base64'),{mode:0o600})
          args.push('-i',file)
        }
      }
      args.push('-')
      await new Promise<void>((resolve,reject)=>{
        const child=spawn(process.env.MAOQIU_CHAT_CODEX||'codex',args,{cwd:dir,env:codexEnvironment(process.env),stdio:['pipe','ignore','pipe'],windowsHide:true,timeout:180000})
        let diagnostic=''
        child.stderr.setEncoding('utf8').on('data',x=>{diagnostic=(diagnostic+x).slice(-1500)})
        child.once('error',()=>reject(new Error('无法启动主聊 Codex，请核对本机安装路径')))
        child.once('close',code=>code===0?resolve():reject(new Error(/401|unauthorized/i.test(diagnostic)
          ?'主聊认证失败，请核对本机 Codex 登录状态'
          :'主聊模型未返回结果，请检查 Codex 状态后重新发送')))
        child.stdin.on('error',()=>{})
        child.stdin.end(prompt)
      })
      try{return JSON.parse(readFileSync(join(dir,'result.json'),'utf8'))}
      catch{throw Error('主聊模型返回的结果无法读取')}
    }finally{rmSync(dir,{recursive:true,force:true})}
  }
}
