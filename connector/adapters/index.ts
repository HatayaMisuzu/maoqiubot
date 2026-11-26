import {Codex} from './codex.ts'
import {Dsh} from './dsh.ts'
import type {Adapter,Instance} from '../types.ts'

type Registration={create:new(instance:Instance)=>Adapter;homeVariable:string;homeDirectory:string;localOnly?:boolean}
export const registry=new Map<string,Registration>([
  ['codex',{create:Codex,homeVariable:'CODEX_HOME',homeDirectory:'.codex',localOnly:true}],
  ['dsh',{create:Dsh,homeVariable:'DSH_HOME',homeDirectory:'.dsh'}]
])
