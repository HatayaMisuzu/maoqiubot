process.parentPort.once('message', ({ data }) => {
  if (data === 'stop') process.emit('SIGTERM')
})

await import('../connector/index.ts')
