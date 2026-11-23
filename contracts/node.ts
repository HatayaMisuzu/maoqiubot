export type ModelOption = {id:string,label:string}
export type ModelState = {current:string|null,options?:ModelOption[]}
export type NodeCommand = {
  id: string, threadId: string, runId: string, taskId: string | null, instanceId: string,
  projectId?: string | null, profileId?: string, workspaceRef?: string,
  kind: 'run' | 'prepare' | 'steer' | 'cancel' | 'answer',
  payload: {text?: string, sessionId?: string, nativeRunId?: string, requestId?: string, choice?: string, modelId?:string, attachmentIds?: string[], homeAccess?: {token:string,projectId:string}}
}
export type NodeEvent = {
  key: string, seq: number, instanceId: string, commandId: string, runId: string,
  kind: 'accepted' | 'message' | 'activity' | 'input_required' | 'artifact' | 'model_state' | 'completed' | 'failed' | 'cancelled' | 'blocked',
  data: {text?: string, sessionId?: string, nativeRunId?: string, requestId?: string, options?: unknown[], [key: string]: any}
}
