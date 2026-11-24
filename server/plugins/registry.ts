import { Ajv } from 'ajv'
import type { ValidateFunction } from 'ajv'
import { fail } from '../db/index.ts'
import type { ChatToolDefinition } from '../chat/provider.ts'

const ajv=new Ajv({strict:false,ownProperties:true,validateSchema:true})
export function validateSchema(schema:object):ValidateFunction{
  try{return ajv.compile(schema)}catch{fail('JSON Schema 无效或包含无法解析的引用')}
}
export type ToolEntry<Context>=ChatToolDefinition&{
  allowed?(context:Context):boolean;
  confirm?:boolean|((args:Record<string,unknown>)=>boolean);
  async?:boolean;
  execute(context:Context,args:any):unknown;
}
export function toolEntry<Context>(definition:ToolEntry<Context>){
  const validate=validateSchema(definition.parameters)
  return {...definition,validate}
}
export type RegisteredTool<Context>=ReturnType<typeof toolEntry<Context>>

export function parseTool<Context>(tool:RegisteredTool<Context>,raw:string){
  if(typeof raw!=='string'||raw.length>16000)fail('工具参数过大')
  let args:unknown
  try{args=JSON.parse(raw)}catch{fail('工具参数不是有效 JSON')}
  if(!args||typeof args!=='object'||Array.isArray(args))fail('工具参数必须是对象')
  if(!tool.validate(args))fail('工具参数不符合定义：'+(tool.validate.errors?.[0]?.instancePath||'参数对象'))
  return args as Record<string,unknown>
}
