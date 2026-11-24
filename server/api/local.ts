import type { IncomingMessage } from 'node:http'

export function isLocal(req:IncomingMessage) {
  const address=req.socket.remoteAddress
  const host=req.headers.host??''
  const parts=/^(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host)
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address??'') &&
    !!parts && (!parts[1]||Number(parts[1])<=65535) &&
    !Object.keys(req.headers).some(k=>k==='forwarded'||k.startsWith('x-forwarded-'))
}
