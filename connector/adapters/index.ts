import {homedir} from 'node:os'
import {join} from 'node:path'
import {Codex} from './codex.ts'
import {Dsh} from './dsh.ts'
import {Hermes} from './hermes.ts'
import type {Adapter,Instance} from '../types.ts'

type Registration={create:new(instance:Instance)=>Adapter;homeVariable:string;defaultHome:string;localOnly?:boolean}
const userHome=homedir()
const hermesSuffix=process.env.HERMES_DATA_DIR_SUFFIX??''
const hermesHome=process.platform==='win32'?
  join(process.env.LOCALAPPDATA||join(userHome,'AppData','Local'),'hermes'+hermesSuffix):
  join(userHome,'.hermes'+hermesSuffix)
export const registry=new Map<string,Registration>([
  ['codex',{create:Codex,homeVariable:'CODEX_HOME',defaultHome:join(userHome,'.codex'),localOnly:true}],
  ['dsh',{create:Dsh,homeVariable:'DSH_HOME',defaultHome:join(userHome,'.dsh')}],
  ['hermes',{create:Hermes,homeVariable:'HERMES_HOME',defaultHome:hermesHome}]
])
