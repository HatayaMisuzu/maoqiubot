/*
 * runKeyedSerializedOperation from Orca, baf50e624fc7616e01942220c2d57c05304d7fdb
 * https://github.com/stablyai/orca/blob/baf50e624fc7616e01942220c2d57c05304d7fdb/src/shared/concurrency/keyed-serialized-operations.ts
 * Copyright (c) 2026 Lovecast Inc. MIT License. See THIRD_PARTY_NOTICES.md.
 */
/** Queue tails never reject; operation failures propagate only to their enqueuer. */
export function runKeyedSerializedOperation<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const current = previous.then(operation)
  const queued = current.then(
    () => undefined,
    () => undefined
  )
  queues.set(key, queued)

  const clear = (): void => {
    if (queues.get(key) === queued) {
      queues.delete(key)
    }
  }
  queued.then(clear, clear)
  return current
}
