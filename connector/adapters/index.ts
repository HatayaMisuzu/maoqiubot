import {Codex} from './codex.ts'
import {Dsh} from './dsh.ts'
import type {Adapter,Instance} from '../types.ts'
export const registry:Record<string,new(instance:Instance)=>Adapter>={codex:Codex,dsh:Dsh}
