import { fail, iso, projectAccess, one, now } from './common.ts'
import type { Context, DB } from './common.ts'

export function initSearch(db:DB) {
  db.exec(`
    CREATE INDEX records_project_updated ON records(project_id,updated_at) WHERE forgotten=0;
    CREATE INDEX sources_created ON sources(created_at);
    CREATE INDEX sources_platform_created ON sources(platform,created_at);
    CREATE INDEX records_source ON records(source_id);
  `)
  try {
    db.exec("CREATE VIRTUAL TABLE archive_search USING fts5(body, tokenize='trigram')")
  } catch(e) {
    if(/no such module: fts5|no such tokenizer: trigram/i.test((e as Error).message))return
    throw e
  }
  db.exec(`
    CREATE TABLE archive_search_keys(key INTEGER PRIMARY KEY,kind TEXT NOT NULL,objectId TEXT NOT NULL,UNIQUE(kind,objectId));
    INSERT INTO archive_search_keys(kind,objectId) SELECT 'source',id FROM sources UNION ALL SELECT 'record',id FROM records;
    INSERT INTO archive_search(rowid,body)
      SELECT k.key,s.title || ' ' || s.text FROM sources s JOIN archive_search_keys k ON k.kind='source' AND k.objectId=s.id;
    INSERT INTO archive_search(rowid,body)
      SELECT k.key,json_extract(v.snapshot,'$.body') FROM records r
      JOIN record_revisions v ON v.record_id=r.id AND v.rev=r.revision
      JOIN archive_search_keys k ON k.kind='record' AND k.objectId=r.id WHERE r.forgotten=0;
    CREATE TRIGGER search_source_insert AFTER INSERT ON sources BEGIN
      INSERT INTO archive_search_keys(kind,objectId) VALUES('source',new.id);
      INSERT INTO archive_search(rowid,body) VALUES(last_insert_rowid(),new.title || ' ' || new.text);
    END;
    CREATE TRIGGER search_source_update AFTER UPDATE OF title,text ON sources BEGIN
      UPDATE archive_search SET body=new.title || ' ' || new.text
        WHERE rowid=(SELECT key FROM archive_search_keys WHERE kind='source' AND objectId=new.id);
    END;
    CREATE TRIGGER search_source_delete AFTER DELETE ON sources BEGIN
      DELETE FROM archive_search WHERE rowid=(SELECT key FROM archive_search_keys WHERE kind='source' AND objectId=old.id);
      DELETE FROM archive_search_keys WHERE kind='source' AND objectId=old.id;
    END;
    CREATE TRIGGER search_record_insert AFTER INSERT ON records BEGIN
      INSERT INTO archive_search_keys(kind,objectId) VALUES('record',new.id);
    END;
    CREATE TRIGGER search_record_update AFTER UPDATE OF forgotten,revision ON records
      WHEN old.forgotten<>new.forgotten OR old.revision<>new.revision BEGIN
      DELETE FROM archive_search WHERE rowid=(SELECT key FROM archive_search_keys WHERE kind='record' AND objectId=new.id);
      INSERT INTO archive_search(rowid,body)
        SELECT k.key,json_extract(v.snapshot,'$.body') FROM record_revisions v
        JOIN archive_search_keys k ON k.kind='record' AND k.objectId=new.id
        WHERE v.record_id=new.id AND v.rev=new.revision AND new.forgotten=0;
    END;
    CREATE TRIGGER search_record_revision AFTER INSERT ON record_revisions BEGIN
      INSERT INTO archive_search(rowid,body)
        SELECT k.key,json_extract(new.snapshot,'$.body') FROM records r
        JOIN archive_search_keys k ON k.kind='record' AND k.objectId=r.id
        WHERE r.id=new.record_id AND r.revision=new.rev AND r.forgotten=0;
    END;
    CREATE TRIGGER search_record_delete AFTER DELETE ON records BEGIN
      DELETE FROM archive_search WHERE rowid=(SELECT key FROM archive_search_keys WHERE kind='record' AND objectId=old.id);
      DELETE FROM archive_search_keys WHERE kind='record' AND objectId=old.id;
    END;
  `)
}

type Cursor=[number,string,string,string]
const fallbackConnections=new WeakSet<DB>()
function readCursor(value:string|null):Cursor|null {
  if(!value)return null
  try {
    if(value.length>512 || !/^[\w-]+$/.test(value))throw Error()
    const fields=JSON.parse(Buffer.from(value,'base64url').toString('utf8'))
    if(!Array.isArray(fields)||fields.length!==4||![0,1].includes(fields[0])||!fields.slice(1).every(x=>typeof x==='string'))throw Error()
    return fields as Cursor
  } catch { fail(400,'检索游标无效') }
}

export function search(db:DB,ctx:Context) {
  const {principal:p,query:q}=ctx,project=q.get('projectId'),query=(q.get('q')??'').trim()
  if(project)projectAccess(db,p,project)
  if(query.length>500||query.includes('\0'))fail(400,'检索词须在 500 字符以内')
  const explicit=[...new Set([...q.getAll('ref'),...q.getAll('id')])]
  if(explicit.length>100 || explicit.some(ref=>ref.length>128))fail(400,'检索引用过多或无效')
  const requested=Number(q.get('limit')??50)
  if(!Number.isSafeInteger(requested)||requested<1)fail(400,'limit 须为正整数')
  const limit=Math.min(requested,100),cursor=readCursor(q.get('cursor'))
  const kind=q.get('kind'),scope=q.get('scope')
  if(kind && !['record','source'].includes(kind))fail(400,'未知检索类型')
  if(scope && (scope!=='personal'||project||!p.owner))fail(403,'个人资料仅对所有者开放')
  const indexed=Array.from(query).length>=3&&one(db,"SELECT 1 FROM sqlite_schema WHERE name='archive_search'")
  if(!indexed&&!fallbackConnections.has(db)){
    db.function('search_fold',{deterministic:true},v=>String(v??'').toLowerCase())
    fallbackConnections.add(db)
  }
  const hit=(alias:string,body:string)=>indexed?'':`AND ($text='' OR ${alias}.id IN explicit OR instr(search_fold(${body}),$text)>0)`
  const candidates=(kind:string,table:string,alias:string)=>indexed
    ? `matches JOIN ${table} ${alias} ON ${alias}.id=matches.objectId AND matches.kind='${kind}'`
    : `${table} ${alias}`
  const recordBody="json_extract(v.snapshot,'$.body')",sourceBody="s.title||' '||s.text"
  const result=db.prepare(`
    WITH allowed_projects AS (SELECT value AS id FROM json_each($projects)),
    explicit AS (SELECT value AS id FROM json_each($explicit)),
    ${indexed?`matches AS (
      SELECT k.kind,k.objectId FROM archive_search JOIN archive_search_keys k ON k.key=archive_search.rowid
        WHERE archive_search MATCH $text
      UNION SELECT 'record',id FROM explicit UNION SELECT 'source',id FROM explicit
    ),`:''}
    hits AS (
      SELECT r.id,'record' AS kind,r.kind AS type,substr(${recordBody},1,240) AS summary,
        s.id AS sourceId,r.updated_at AS at,r.revision,
        r.id IN explicit AS pinned
      FROM ${candidates('record','records','r')} JOIN record_revisions v ON v.record_id=r.id AND v.rev=r.revision
      LEFT JOIN sources s ON s.id=r.source_id AND (r.project_id IS NULL OR r.project_id IN (SELECT value FROM json_each(s.acl,'$.projects')))
      WHERE ($kind IS NULL OR $kind='record') AND r.forgotten=0
        AND ($owner OR r.project_id IN allowed_projects)
        AND ($project IS NULL OR r.project_id=$project)
        AND (NOT $personal OR r.project_id IS NULL)
        AND ($from IS NULL OR r.updated_at >= $from) AND ($to IS NULL OR r.updated_at <= $to)
        AND ($source IS NULL OR s.id=$source) AND ($platform IS NULL OR s.platform=$platform)
        AND COALESCE(json_extract(v.snapshot,'$.validFrom'),'') <= $now
        AND COALESCE(json_extract(v.snapshot,'$.validUntil'),'9999') > $now
        ${hit('r',recordBody)}
      UNION ALL
      SELECT s.id,'source',NULL,substr(${sourceBody},1,240),s.id,s.created_at,NULL,s.id IN explicit
      FROM ${candidates('source','sources','s')}
      WHERE ($kind IS NULL OR $kind='source')
        AND ($owner OR EXISTS(SELECT 1 FROM json_each(s.acl,'$.projects') WHERE value IN allowed_projects)
          OR $endpoint IN (SELECT value FROM json_each(s.acl,'$.endpoints')))
        AND ($project IS NULL OR $project IN (SELECT value FROM json_each(s.acl,'$.projects')))
        AND (NOT $personal OR (json_array_length(s.acl,'$.projects')=0 AND json_array_length(s.acl,'$.endpoints')=0))
        AND ($from IS NULL OR s.created_at >= $from) AND ($to IS NULL OR s.created_at <= $to)
        AND ($source IS NULL OR s.id=$source) AND ($platform IS NULL OR s.platform=$platform)
        ${hit('s',sourceBody)}
    )
    SELECT * FROM hits WHERE ($pin IS NULL OR (pinned,at,kind,id)<($pin,$at,$lastKind,$lastId))
    ORDER BY pinned DESC,at DESC,kind DESC,id DESC LIMIT $limit
  `).all({
    $projects:JSON.stringify(p.projects),$explicit:JSON.stringify(explicit),$kind:kind||null,
    $owner:Number(p.owner),$endpoint:p.runPermission?null:p.id,$project:project,$personal:Number(scope==='personal'),
    $from:iso(q.get('from'),'from'),$to:iso(q.get('to'),'to'),$source:q.get('sourceId'),$platform:q.get('platform'),$now:now(),
    $text:indexed?'"'+query.replaceAll('"','""')+'"':query.toLowerCase(),
    $pin:cursor?.[0]??null,$at:cursor?.[1]??null,$lastKind:cursor?.[2]??null,$lastId:cursor?.[3]??null,$limit:limit+1
  })
  const last=result.length>limit?result[limit-1]:null
  return {
    items:result.slice(0,limit).map(({pinned,type,revision,...r})=>({
      ...r,...(type?{type,revision}:{}),href:'/api/v1/'+r.kind+'s/'+r.id
    })),
    nextCursor:last?Buffer.from(JSON.stringify([last.pinned,last.at,last.kind,last.id])).toString('base64url'):null
  }
}
