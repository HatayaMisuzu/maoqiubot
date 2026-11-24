export type ModelOption = {id:string,label:string}
export type ModelState = {current:string|null,options?:ModelOption[]}
export type NativeSession={id:string;title:string;updatedAt:number;active:boolean}
export type Actor={kind:'user'|'main_bot'|'work_bot'|'system'|'tool';id:string}
export type Audience={kind:'user'|'bot'|'task'|'system';id:string}
export type Communication={sender:Actor;recipient:Audience;type:string;visibility:'user_visible'|'bot_internal'|'system';
  replyTo?:string;messageId?:string;threadId?:string;projectId?:string|null;taskId?:string|null;runId?:string;sourceMessageId?:string}
export type NodeCommand = {
  id: string, threadId: string, runId: string, taskId: string | null, instanceId: string,
  projectId?: string | null, profileId?: string, workspaceRef?: string,
  kind: 'run' | 'prepare' | 'steer' | 'cancel' | 'answer',
  payload: {text?: string, inputText?:string, sessionId?: string, nativeRunId?: string, requestId?: string, choice?: string, modelId?:string, attachmentIds?: string[],
    materials?:unknown[],importSessionId?:string,communication?:Communication,homeAccess?: {token:string,projectId:string,permission?:'read'|'append'|'manage'}}
}
export type NodeEvent = {
  key: string, seq: number, instanceId: string, commandId: string, runId: string,
  kind: 'accepted' | 'message' | 'activity' | 'input_required' | 'artifact' | 'model_state' | 'completed' | 'failed' | 'cancelled' | 'blocked',
  data: {text?: string, sessionId?: string, nativeRunId?: string, requestId?: string, options?: unknown[], [key: string]: any}
}
