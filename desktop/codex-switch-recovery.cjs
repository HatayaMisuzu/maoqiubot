const { createHash, randomUUID } = require('node:crypto')
const { linkSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs')

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256 = /^[a-f0-9]{64}$/
const idPattern = /^[a-f0-9-]{36}$/
const recordPath = file => file + '.codex-switch.json'
const backupPath = (file, id) => file + '.codex-switch-' + id + '.old'

function readRegular(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return undefined
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Codex 切换恢复文件须为普通文件')
  return readFileSync(path)
}

function replaceFile(file, bytes) {
  const stage = file + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(stage, bytes, { flag: 'wx', mode: 0o600, flush: true })
    renameSync(stage, file)
  }
  finally {
    if (lstatSync(stage, { throwIfNoEntry: false })) unlinkSync(stage)
  }
}

function recoverCodexSwitch(file, db) {
  const path = recordPath(file)
  const saved = readRegular(path)
  if (!saved) {
    db.prepare('DELETE FROM desktop_codex_switch').run()
    return
  }
  let record
  try { record = JSON.parse(saved) } catch {}
  if (record?.version !== 1 || typeof record.id !== 'string' || !idPattern.test(record.id) ||
    typeof record.old !== 'string' || !sha256.test(record.old) || typeof record.next !== 'string' ||
    !sha256.test(record.next) || record.old === record.next) throw Error('无法核对 Codex 切换恢复记录，请保留恢复文件并检查连接器配置')
  const backup = backupPath(file, record.id)
  const old = readRegular(backup)
  if (old && digest(old) !== record.old) throw Error('Codex 切换备份内容已变化，已暂停连接器')
  const current = readRegular(file)
  const actual = current && digest(current)
  const committed = db.prepare('SELECT 1 FROM desktop_codex_switch WHERE id=?').get(record.id)
  if (committed) {
    if (actual !== record.next) throw Error('已提交的 Codex 切换与配置文件不符，已暂停连接器')
  } else if (actual === record.next && old) {
    renameSync(backup, file)
  } else if (actual !== record.old) {
    throw Error('Codex 切换期间配置文件已变化，已暂停连接器以保留手工改动')
  }
  if (lstatSync(backup, { throwIfNoEntry: false })) unlinkSync(backup)
  unlinkSync(path)
  db.prepare('DELETE FROM desktop_codex_switch WHERE id=?').run(record.id)
}

function commitCodexSwitch(file, db, previous, next, update) {
  recoverCodexSwitch(file, db)
  if (!readRegular(file)?.equals(previous)) throw Error('连接器配置已变化，请重新预览')
  const id = randomUUID()
  const changingFile = !previous.equals(next)
  let beginning = false
  let committed = false
  try {
    db.exec('BEGIN IMMEDIATE')
    beginning = true
    if (changingFile) {
      const record = { version: 1, id, old: digest(previous), next: digest(next) }
      replaceFile(recordPath(file), JSON.stringify(record) + '\n')
      // The original and its temporary name share the same file contents and permissions.
      linkSync(file, backupPath(file, id))
      if (!readRegular(file)?.equals(previous)) throw Error('连接器配置已变化，请重新预览')
      replaceFile(file, next)
      db.prepare('INSERT INTO desktop_codex_switch VALUES(?)').run(id)
    }
    update()
    if (!readRegular(file)?.equals(next)) throw Error('切换期间连接器配置已变化，请重新预览')
    db.exec('COMMIT')
    committed = true
    beginning = false
    if (changingFile) recoverCodexSwitch(file, db)
  } catch (error) {
    try {
      if (beginning && db.isTransaction) db.exec('ROLLBACK')
      if (changingFile && !committed) committed = Boolean(db.prepare('SELECT 1 FROM desktop_codex_switch WHERE id=?').get(id))
      recoverCodexSwitch(file, db)
    } catch (recovery) {
      throw Object.assign(Error('Codex 切换失败，配置恢复待核对。' + error.message + '；' + recovery.message), {
        cause: error, recoveryRequired: true
      })
    }
    if (committed) return
    throw error
  }
}

module.exports = { commitCodexSwitch, recoverCodexSwitch }
