import type { DatabaseSync } from 'node:sqlite'
import { id, now } from './index.ts'

export function initSessions(db:DatabaseSync) {
  db.exec(`
    ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'side' CHECK(kind IN ('main','side','native','api'));
    ALTER TABLE threads ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived','deleted','purged'));
    ALTER TABLE threads ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE threads ADD COLUMN lastActivity TEXT;
    ALTER TABLE threads ADD COLUMN contextRevision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE threads ADD COLUMN nativeArchived INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE threads ADD COLUMN nativeInvalid TEXT;
    UPDATE threads SET kind='native', source=CASE
      WHEN EXISTS(SELECT 1 FROM commands c WHERE c.threadId=threads.id AND json_extract(c.payload,'$.importSessionId') IS NOT NULL) THEN 'imported'
      WHEN EXISTS(SELECT 1 FROM tasks t WHERE t.workThreadId=threads.id AND t.originThreadId<>threads.id) THEN 'delegated'
      ELSE 'direct' END WHERE instanceId<>'main';
    UPDATE threads SET lastActivity=COALESCE((SELECT m.createdAt FROM messages m
      WHERE m.threadId=threads.id ORDER BY m.rowid DESC LIMIT 1),createdAt);
    CREATE UNIQUE INDEX threads_one_main ON threads(kind) WHERE kind='main';
    CREATE INDEX threads_recent ON threads(instanceId,state,lastActivity DESC,id);
    CREATE INDEX messages_by_thread_kind ON messages(threadId,kind);
    CREATE TRIGGER threads_new_activity AFTER INSERT ON threads WHEN NEW.lastActivity IS NULL BEGIN
      UPDATE threads SET lastActivity=NEW.createdAt WHERE id=NEW.id;
    END;
    CREATE TRIGGER messages_thread_activity AFTER INSERT ON messages BEGIN
      UPDATE threads SET lastActivity=NEW.createdAt WHERE id=NEW.threadId;
    END;
    CREATE TABLE thread_shares(messageId TEXT PRIMARY KEY REFERENCES messages(id),
      targetThreadId TEXT NOT NULL REFERENCES threads(id), sentWith TEXT REFERENCES messages(id));
    CREATE INDEX thread_pending_shares ON thread_shares(targetThreadId) WHERE sentWith IS NULL;
  `)
  const candidate=db.prepare(`SELECT t.id FROM threads t WHERE t.instanceId='main' AND t.projectId IS NULL AND t.taskId IS NULL
    AND EXISTS(SELECT 1 FROM messages m WHERE m.threadId=t.id AND m.kind='message' AND m.role='user')
    AND NOT EXISTS(SELECT 1 FROM task_drafts d WHERE d.threadId=t.id)
    ORDER BY (SELECT MAX(m.rowid) FROM messages m WHERE m.threadId=t.id AND m.kind='message') DESC LIMIT 1`).get()
  if(candidate) db.prepare("UPDATE threads SET kind='main',source='migrated' WHERE id=?").run(candidate.id)
  else db.prepare("INSERT INTO threads(id,title,instanceId,kind,source,createdAt) VALUES(?,'小毛球','main','main','identity',?)").run(id(),now())
}
