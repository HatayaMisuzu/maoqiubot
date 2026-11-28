import type {NodeCommand,ModelOption,ModelState,NativeSession,NativeAction,NativeHistory,UsageWindow} from '../contracts/node.ts'
export interface Instance {
  id: string
  name: string
  adapterKey: string
  workspaceRef: string
  profileId?: string
  codexProviderMode?: 'official' | 'native'
  runtimeKey?: string
  runtimeScopeId?:string
  command: string
  args: string[]
  env?: Record<string, string>
}
export type Command = NodeCommand & {payload: {attachments?: (string | {id:string})[]}}
export interface Input {text: string, files: {id: string, name: string, path: string, mime: string}[]}
export type Emit = (kind: string, data: Record<string, any>) => void
export interface Run {
  command: Command
  sessionId: string
  nativeRunId?: string
  emit: Emit
}
export type Capabilities = {availableActions: string[], version?: string, history: boolean, resume: boolean, sessionList?:boolean, sessionImport?:boolean, nativeHistory?:boolean, nativeActions?:NativeAction[], models?:ModelOption[], usage?:boolean}
export interface Adapter {
  onDisconnect(handler:(error:Error)=>void):void
  probe(): Promise<Capabilities>
  identity?():Promise<string>
  describeModels?(sessionId:string):ModelState
  open(sessionId?: string): Promise<string>
  listSessions?(cursor?:string):Promise<{items:NativeSession[],nextCursor:string|null}>
  importSession?(sessionId:string):Promise<string>
  readHistory?(sessionId:string,before?:string):Promise<NativeHistory>
  readUsage?():Promise<UsageWindow[]>
  sessionAction?(action:NativeAction,sessionId:string):Promise<string>
  run(run: Run, input: Input): Promise<void>
  cancel(run: Run): Promise<void>
  steer?(run: Run,input: Input): Promise<void>
  answer(run: Run,id: string,choice: string): Promise<void>
  inspect?(run: Run): Promise<boolean>
  close(): void
}
