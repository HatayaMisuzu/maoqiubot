import type { DatabaseSync } from 'node:sqlite'
import type { ModelProtocol } from '../chat/model-settings.ts'

export type BotUsageSource = 'api_response' | 'codex_turn'
type Counts = {inputTokens:number|null;outputTokens:number|null;totalTokens:number|null}

export function initBotUsage(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS bot_usage_receipts (
    runId TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    recordedAt TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('api_response', 'codex_turn')),
    model TEXT,
    inputTokens INTEGER, outputTokens INTEGER, totalTokens INTEGER
  );
  CREATE INDEX IF NOT EXISTS bot_usage_receipts_recent ON bot_usage_receipts(recordedAt);
  CREATE INDEX IF NOT EXISTS bot_usage_by_instance ON runs(instanceId,status);
  CREATE INDEX IF NOT EXISTS bot_usage_by_command ON commands(runId,kind);`)
}

const count = (value:unknown):number|null => typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=1e12 ? value : null
const usageObject = (value:unknown):Record<string,unknown> => value&&typeof value==='object'&&!Array.isArray(value)
  ? value as Record<string,unknown> : {}

function addCounts(first:number|null, second:number|null):number|null {
  return first===null||second===null ? null : count(first+second)
}

export function apiResponseUsage(protocol:ModelProtocol, value:unknown):Counts {
  const usage=usageObject(value)
  if(protocol==='openai-compatible')return {
    inputTokens:count(usage.prompt_tokens),outputTokens:count(usage.completion_tokens),totalTokens:count(usage.total_tokens)
  }
  if(protocol==='openai-responses')return {
    inputTokens:count(usage.input_tokens),outputTokens:count(usage.output_tokens),totalTokens:count(usage.total_tokens)
  }
  if(protocol==='anthropic') {
    let inputTokens=count(usage.input_tokens)
    for(const field of ['cache_creation_input_tokens','cache_read_input_tokens']) {
      if(usage[field]!=null)inputTokens=addCounts(inputTokens,count(usage[field]))
    }
    const outputTokens=count(usage.output_tokens)
    return {inputTokens,outputTokens,totalTokens:addCounts(inputTokens,outputTokens)}
  }
  const candidates=count(usage.candidatesTokenCount)
  const outputTokens=usage.thoughtsTokenCount==null ? candidates : addCounts(candidates,count(usage.thoughtsTokenCount))
  return {inputTokens:count(usage.promptTokenCount),outputTokens,totalTokens:count(usage.totalTokenCount)}
}

export function recordBotUsage(db:DatabaseSync,runId:string,recordedAt:string,source:BotUsageSource,value:unknown) {
  const usage=usageObject(value)
  const inputTokens=count(usage.inputTokens),outputTokens=count(usage.outputTokens)
  const totalTokens=count(usage.totalTokens)??addCounts(inputTokens,outputTokens)
  if(inputTokens===null&&outputTokens===null&&totalTokens===null)return
  const model=typeof usage.model==='string'&&usage.model.trim().length>0 ? usage.model.trim().slice(0,256) : null
  db.prepare(`INSERT INTO bot_usage_receipts(runId,recordedAt,source,model,inputTokens,outputTokens,totalTokens)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(runId) DO NOTHING`).run(runId,recordedAt,source,model,inputTokens,outputTokens,totalTokens)
}
