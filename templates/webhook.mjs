// Framework-agnostic webhook: takes a WHATWG Request, returns a Response.
// Next.js:  export const runtime = 'nodejs'; export const GET = req => handler(req); export const POST = GET
// Hono:     app.all('/api/wechat/webhook', c => handler(c.req.raw))
import { decryptMessage, encryptedReply, freshTimestamp, MAX_BODY_BYTES, parseMessage, textReply, verifySignature } from './wechat-crypto.mjs'
import { PAIR_MESSAGE } from './pairing.mjs'

const plain = (text, status = 200) => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
const normalize = text => text.trim().toLowerCase().replace(/\s+/g, '')

async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new Error('Oversized body')
  const text = await request.text()
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error('Oversized body')
  return text
}

/**
 * @param {object} opts
 * @param {{appId:string, originalId:string, token:string, aesKey:string}} opts.config
 * @param {string[]} opts.loginKeywords            e.g. ['登录'] — one short keyword per site
 * @param {(message) => Promise<string>} opts.onLoginKeyword  returns reply text (code and/or one-tap link)
 * @param {(message, code:string) => Promise<string>} opts.onPairCode  returns reply text
 * @param {object} [opts.replies]                  migrated welcome text, keyword rules and menus
 * @param {Array<{test:(text:string)=>boolean, reply:(message)=>Promise<string>}>} [opts.routes]  extra routes, e.g. download codes
 */
export function createWebhookHandler({ config, loginKeywords, onLoginKeyword, onPairCode, replies = {}, routes = [] }) {
  const keywords = new Set(loginKeywords.map(normalize))
  return async function handle(request) {
    const query = new URL(request.url).searchParams
    const timestamp = query.get('timestamp'), nonce = query.get('nonce')
    if (!freshTimestamp(timestamp) || !nonce || nonce.length > 128) return plain('Forbidden', 403)
    try {
      if (request.method === 'GET') {
        const echo = query.get('echostr')
        if (!echo || echo.length > 4096) return plain('Forbidden', 403)
        if (query.has('msg_signature')) {
          if (!verifySignature(query.get('msg_signature'), config.token, timestamp, nonce, echo)) return plain('Forbidden', 403)
          return plain(decryptMessage(echo, config.appId, config.aesKey))
        }
        if (!verifySignature(query.get('signature'), config.token, timestamp, nonce)) return plain('Forbidden', 403)
        return plain(echo)
      }
      // Plaintext mode cannot authenticate the body, so it must never issue login codes.
      if (query.get('encrypt_type') !== 'aes') return plain('Encrypted messages required', 403)
      const envelope = parseMessage(await readBody(request))
      if (envelope.ToUserName !== config.originalId || typeof envelope.Encrypt !== 'string'
        || !verifySignature(query.get('msg_signature'), config.token, timestamp, nonce, envelope.Encrypt)) return plain('Forbidden', 403)
      const message = parseMessage(decryptMessage(envelope.Encrypt, config.appId, config.aesKey))
      if (message.ToUserName !== config.originalId || !freshTimestamp(message.CreateTime)
        || typeof message.FromUserName !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(message.FromUserName)) return plain('Forbidden', 403)

      const isText = message.MsgType === 'text' && typeof message.Content === 'string'
      const text = isText ? message.Content.trim() : ''
      const needsMsgId = () => typeof message.MsgId === 'string' && /^\d{1,32}$/.test(message.MsgId)
      let content = ''
      try {
        if (isText && keywords.has(normalize(text))) {
          if (!needsMsgId()) return plain('Forbidden', 403)
          content = await onLoginKeyword(message)
        } else if (isText && PAIR_MESSAGE.test(text)) {
          if (!needsMsgId()) return plain('Forbidden', 403)
          content = await onPairCode(message, PAIR_MESSAGE.exec(text)[1])
        } else if (isText && routes.some(r => r.test(text))) {
          if (!needsMsgId()) return plain('Forbidden', 403)
          content = await routes.find(r => r.test(text)).reply(message)
        } else if (message.MsgType === 'event' && message.Event === 'subscribe') {
          content = replies.subscribe || ''
        } else if (message.MsgType === 'event' && message.Event === 'CLICK' && typeof message.EventKey === 'string') {
          content = (replies.menus || []).find(menu => menu.key === message.EventKey)?.reply || ''
        } else if (isText) {
          // Old auto-replies stop working once message push is enabled; they live here now.
          const rule = (replies.keywords || []).find(r => r.keyword && (r.mode === 'contains' ? text.includes(r.keyword) : text === r.keyword))
          const menu = (replies.menus || []).find(m => m.name === text)
          content = rule?.reply || menu?.reply || replies.default || ''
        }
      } catch { return plain('Service unavailable', 503) }
      if (!content) return plain('success')
      return new Response(encryptedReply(textReply(message.FromUserName, config.originalId, content), config, nonce),
        { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' } })
    } catch { return plain('Invalid message', 400) }
  }
}
