export type ModelOption = {id:string,label:string}
export type ModelState = {current:string|null,options?:ModelOption[]}
export type NativeSession={id:string;title:string;updatedAt:number;active:boolean}
export type NativeAction='fork'|'archive'|'unarchive'|'delete'
export type NativeHistory={items:{id:string;turnId:string;role:'user'|'assistant';text:string}[];nextBefore:string|null;archived?:boolean;source?:'native';fetchedAt?:string}
export type UsageWindow={usedPercent:number;durationMinutes:number|null;resetsAt:number|null}
export type NativeUsage={source:'codex_app_server'|null;fetchedAt:string|null;windows:UsageWindow[]}
export type NodeInstanceRegistration={id:string;name:string;adapterKey:string;workspaceRef:string;profileId?:string;runtimeScopeId?:string;
  availableActions:string[];online?:boolean;version?:string;resume?:boolean;history?:boolean;sessionList?:boolean;sessionImport?:boolean;nativeHistory?:boolean;
  nativeActions?:NativeAction[];nativeBindingRelease?:boolean;usage?:boolean;error?:string;models?:ModelOption[]}
export type NodeHello={type:'hello';nodeId:string;receiptLookup?:boolean;cancelBeforeStart?:boolean;scopedCommands?:boolean;nativeBindingProofs?:boolean;instances:NodeInstanceRegistration[]}
export type Actor={kind:'user'|'main_bot'|'work_bot'|'system'|'tool';id:string}
export type Audience={kind:'user'|'bot'|'task'|'system';id:string}
export type Communication={sender:Actor;recipient:Audience;type:string;visibility:'user_visible'|'bot_internal'|'system';
  replyTo?:string;messageId?:string;threadId?:string;projectId?:string|null;taskId?:string|null;runId?:string;sourceMessageId?:string}
export type NodeCommand = {
  id: string, threadId: string, runId: string, taskId: string | null, instanceId: string,
  projectId?: string | null, profileId?: string, workspaceRef?: string, runtimeScopeId?: string,
  kind: 'run' | 'prepare' | 'steer' | 'cancel' | 'answer',
  payload: {text?: string, inputText?:string, sessionId?: string, nativeRunId?: string, requestId?: string, choice?: string, modelId?:string, attachmentIds?: string[],
    materials?:unknown[],importSessionId?:string,nativeOperation?:{action:NativeAction|'release';sourceThreadId:string;sourceSessionId:string},communication?:Communication,communicationAccess?:{token:string},
    homeAccess?: {token:string,projectId:string,permission?:'read'|'append'|'manage'}}
}
export type NodeEvent = {
  key: string, seq: number, instanceId: string, commandId: string, runId: string, threadId?: string, taskId?: string | null, runtimeScopeId?: string,
  kind: 'accepted' | 'message' | 'activity' | 'input_required' | 'artifact' | 'model_state' | 'completed' | 'failed' | 'cancelled' | 'blocked',
  data: {text?: string, sessionId?: string, nativeRunId?: string, requestId?: string, options?: unknown[], usage?: unknown, [key: string]: any}
}
