import type { DatabaseSync } from 'node:sqlite'

export function initChatBudget(db:DatabaseSync){
  const columns=new Set(db.prepare('PRAGMA table_info(chat_jobs)').all().map((column:any)=>String(column.name)))
  if(!columns.has('checkpoint'))db.exec('ALTER TABLE chat_jobs ADD COLUMN checkpoint TEXT')
  if(!columns.has('inFlight'))db.exec('ALTER TABLE chat_jobs ADD COLUMN inFlight TEXT')
  db.exec('ALTER TABLE threads ADD COLUMN toolBudget TEXT')
}
