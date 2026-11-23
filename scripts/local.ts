import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {resolve} from 'node:path'
import {startServer} from '../server/index.ts'

const root=fileURLToPath(new URL('../',import.meta.url))
process.chdir(root)
const app=startServer({host:'127.0.0.1'})
app.server.once('listening',()=>{
  const address=app.server.address() as any
  console.log('小毛球工作台 http://127.0.0.1:'+address.port+'/login?ticket='+app.ticket)
  console.log('本机数据 '+app.dataDir)
  const cfg=resolve(process.argv[2]??'connector/config.example.json')
  const child=spawn(process.execPath,['connector/index.ts',cfg],{
    cwd:root,
    env:{...process.env,NODE_TOKEN:app.auth.cfg.nodes.local,MAOQIU_NODE_URL:'ws://127.0.0.1:'+address.port+'/api/v1/node'},
    stdio:['inherit','inherit','inherit','ipc'],windowsHide:true
  })
  child.on('exit',code=>console.log('节点已退出 '+code+'。后端保留，可单独重启节点。'))
  const stop=()=>{
    if(child.connected)child.disconnect()
    void app.close().then(()=>process.exit())
  }
  process.once('SIGTERM',stop);process.once('SIGINT',stop)
})
