import type { DB } from './common.ts'

// The same predicate protects project endpoints, retrieval and new run context.
export function sharedRecordSql(record='r',version='v'){
  const snapshot=`CASE WHEN linked.id=${record}.id THEN ${version}.snapshot ELSE latest.snapshot END`
  const dependsOn=(path:string,id:string,filter:string)=>`
    SELECT ${id} FROM dependencies d
    JOIN records linked ON linked.id=d.id AND linked.project_id IS ${record}.project_id
    JOIN record_revisions latest ON latest.record_id=linked.id AND latest.rev=linked.revision
    JOIN json_each(${snapshot},'${path}') ref
    WHERE ${filter} AND COALESCE(json_extract(${snapshot},'$.independentKnowledge'),0)<>1`
  const hasAsset=(table:'sources'|'attachments',id:string)=>`EXISTS(
    SELECT 1 FROM ${table} a, json_each(a.acl,'$.projects') access
    WHERE a.id=${id} AND access.value=${record}.project_id
  )`
  // UNION visits each ID once, including when record citations form a cycle.
  return `NOT EXISTS (
    WITH RECURSIVE dependencies(id) AS (
      SELECT ${record}.id
      UNION ${dependsOn('$.refs','ref.value',"ref.type='text'")}
      UNION ${dependsOn('$.extra.refs',"json_extract(ref.value,'$.id')",
        "CASE WHEN ref.type='object' THEN json_extract(ref.value,'$.type')='record' ELSE 0 END")}
    )
    SELECT 1 FROM dependencies d
    LEFT JOIN records linked ON linked.id=d.id AND linked.project_id IS ${record}.project_id AND linked.forgotten=0
    LEFT JOIN record_revisions latest ON latest.record_id=linked.id AND latest.rev=linked.revision
    WHERE latest.snapshot IS NULL OR COALESCE(json_extract(${snapshot},'$.shareDerived'),1)<>1
      OR (COALESCE(json_extract(${snapshot},'$.independentKnowledge'),0)<>1 AND (
        (linked.source_id IS NOT NULL AND NOT ${hasAsset('sources','linked.source_id')})
        OR EXISTS(SELECT 1 FROM json_each(${snapshot},'$.extra.refs') ref
          WHERE CASE WHEN ref.type='object' THEN CASE json_extract(ref.value,'$.type')
            WHEN 'source' THEN NOT ${hasAsset('sources',"json_extract(ref.value,'$.id')")}
            WHEN 'attachment' THEN NOT ${hasAsset('attachments',"json_extract(ref.value,'$.id')")}
            ELSE 0 END ELSE 0 END)
      ))
  )`
}

export function resetChatContext(db:DB,projectId:string|null){
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='thread_context_resets' AND type='table'").get())return
  db.prepare(`INSERT INTO thread_context_resets(threadId,throughMessageId)
    SELECT t.id,(SELECT id FROM messages WHERE threadId=t.id ORDER BY rowid DESC LIMIT 1) FROM threads t
    WHERE t.instanceId='main' AND (? IS NULL OR t.projectId=?) AND EXISTS(SELECT 1 FROM messages WHERE threadId=t.id)
    ON CONFLICT(threadId) DO UPDATE SET throughMessageId=excluded.throughMessageId,version=version+1`).run(projectId,projectId)
  db.prepare(`DELETE FROM thread_summaries WHERE threadId IN
    (SELECT id FROM threads WHERE instanceId='main' AND (? IS NULL OR projectId=?))`).run(projectId,projectId)
}
