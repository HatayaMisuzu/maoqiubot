import type { IncomingMessage } from 'node:http'

export function isLocal(req:IncomingMessage) {
  const address=req.socket.remoteAddress
  const host=URL.parse('http://'+req.headers.host)?.hostname
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address??'') &&
    ['localhost','127.0.0.1','[::1]'].includes(host??'') &&
    !req.headers.forwarded && !Object.keys(req.headers).some(k=>k.startsWith('x-forwarded-'))
}
