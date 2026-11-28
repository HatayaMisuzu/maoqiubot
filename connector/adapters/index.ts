import {Codex} from './codex.ts'
import {Dsh} from './dsh.ts'
import {Hermes} from './hermes.ts'
import type {Adapter,Instance} from '../types.ts'

type Registration={create:new(instance:Instance)=>Adapter;localOnly?:boolean}
export const registry=new Map<string,Registration>([
  ['codex',{create:Codex,localOnly:true}],
  ['dsh',{create:Dsh}],
  ['hermes',{create:Hermes}]
])
