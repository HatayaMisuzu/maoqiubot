export const pluginApiVersion=1
export type PluginCapability='tools'|'providers'|'skills'|'events'|'network.public'|'network.api'
export type PluginManifest={
  id:string; name:string; version:string; hostApi:typeof pluginApiVersion; description:string;
  entry?:string; skills?:string[]; requires?:string[]; capabilities:PluginCapability[];
  configSchema?:object; httpTools?:DeclarativeTool[];
}
export type ToolContext={
  actor:'user'|'work_bot'|'system'
  threadId:string; messageId:string; projectId:string|null; taskId?:string; runId?:string
  requestText?:string; signal:AbortSignal; maxResultBytes:number
  authorizedDestinations:readonly string[]
}
export type ToolDefinition={
  name:string; description:string; parameters:object; risk:'read'|'confirm';
  network?:'network.public'|'network.api';
  execute(args:Record<string,unknown>,ctx:ToolContext):unknown|Promise<unknown>
}
export type ToolReference={id:string;url:string;title:string;retrievedAt:string}
export type ToolResult={summary?:string;data?:unknown;references?:ToolReference[];attachments?:string[];error?:{code:string;message:string}}
export type SkillResource={path:string}
export type PluginEvent={
  type:'tool.finished'|'task.communication'|'task.delivery';
  threadId:string; messageId:string; projectId:string|null; name?:string; ok?:boolean
}
export type PluginProvider={
  id:string; name:string;
  generate(input:{instruction:string; context:string; signal?:AbortSignal}):Promise<string>
}
export type Disposable=()=>void
export type PluginContext={
  readonly config:Readonly<Record<string,unknown>>
  readonly dataDir:string
  registerTool(tool:ToolDefinition):Disposable
  registerProvider(provider:PluginProvider):Disposable
  registerSkill(skill:SkillResource):Disposable
  on(type:PluginEvent['type'],handler:(event:PluginEvent)=>void|Promise<void>):Disposable
}
export type PluginModule={activate(ctx:PluginContext):void|Promise<void>;deactivate?():void|Promise<void>;
  test?(config:Readonly<Record<string,unknown>>,input:Record<string,unknown>,signal:AbortSignal):Promise<unknown>}

export type DeclarativeTool={
  name:string; description:string; parameters:object;
  endpoint:string; method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE'; privateLan?:boolean;
  path?:string; query?:Record<string,string>; body?:Record<string,string>; outputPath?:string[];
  keyEnv?:string; timeoutMs?:number; maxBytes?:number;
}
