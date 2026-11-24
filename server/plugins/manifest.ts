import type { PluginManifest } from '../../contracts/plugin.ts'
import { pluginApiVersion } from '../../contracts/plugin.ts'
import { fail } from '../db/index.ts'
import { declarativeTool } from './api-tool.ts'
import { packagePath,readText,relativePath } from './files.ts'
import { validateSchema } from './registry.ts'

const identifier={type:'string',pattern:'^[a-z][a-z0-9-]{0,39}$'}
const validateManifest=validateSchema({type:'object',additionalProperties:false,
  required:['id','name','version','hostApi','description','capabilities'],
  properties:{
    id:identifier,name:{type:'string',minLength:1,maxLength:80},description:{type:'string',minLength:1,maxLength:400},
    version:{type:'string',pattern:'^\\d+\\.\\d+\\.\\d+(?:-[a-zA-Z0-9.-]+)?$',maxLength:50},hostApi:{const:pluginApiVersion},
    entry:{type:'string',pattern:'\\.(?:mjs|js|ts)$',maxLength:120},configSchema:{type:'object'},
    skills:{type:'array',uniqueItems:true,maxItems:35,items:{type:'string',maxLength:160}},
    requires:{type:'array',uniqueItems:true,maxItems:10,items:identifier},
    capabilities:{type:'array',uniqueItems:true,items:{enum:['tools','providers','skills','events','network.public','network.api']}},
    httpTools:{type:'array',maxItems:20,items:{type:'object'}}
  }})
export function pluginManifest(root:string):PluginManifest{
  let manifest:PluginManifest
  try{manifest=JSON.parse(readText(root,'plugin.json',96000))}catch{fail('插件缺少有效的 plugin.json')}
  if(!validateManifest(manifest))fail('插件清单无效或宿主 API 版本不兼容：'+(validateManifest.errors?.[0]?.instancePath||'插件属性'))
  if(manifest.entry)packagePath(root,manifest.entry)
  if(manifest.skills?.length&&!manifest.capabilities.includes('skills'))fail('插件清单未声明 skills 能力')
  for(const skill of manifest.skills??[])packagePath(root,relativePath(skill)+'/SKILL.md')
  if(manifest.httpTools?.length&&(!manifest.capabilities.includes('tools')||!manifest.capabilities.includes('network.api')))
    fail('声明式 API 插件须声明 tools 和 network.api 能力')
  for(const tool of manifest.httpTools??[])declarativeTool(tool)
  if(manifest.configSchema)validateSchema(manifest.configSchema)
  if(manifest.requires?.includes(manifest.id))fail('插件不能依赖自身')
  return manifest
}
