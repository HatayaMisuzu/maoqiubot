async function maintainConnector(lifecycle, { restart = false, keepPaused = false } = {}, operation = () => {}) {
  const previousPause = lifecycle.pause(true)
  let stopping = false
  let result
  try {
    lifecycle.assertIdle(restart)
    stopping = true
    await lifecycle.stop()
    if (!restart) lifecycle.assertIdle(false)
    result = await operation()
  } catch (error) {
    if (!stopping || error.connectorStillServing) {
      lifecycle.pause(previousPause)
      throw error
    }
    if (lifecycle.running()) {
      lifecycle.resumeAfterExit()
      throw error
    }
    try { lifecycle.resume() }
    catch (recovery) {
      throw Error(error.message + '。连接器恢复失败：' + recovery.message, { cause: error })
    }
    throw error
  }
  if (keepPaused) return { result }
  try {
    lifecycle.resume()
    return { result }
  } catch (startError) {
    return { result, startError }
  }
}

module.exports = { maintainConnector }
