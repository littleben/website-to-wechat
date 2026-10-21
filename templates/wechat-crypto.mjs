// WeChat official-account message encryption (安全模式), signatures and text replies.
// Extracted from a production webhook; no framework dependency besides fast-xml-parser.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

export const MAX_BODY_BYTES = 64 * 1024
const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: false, processEntities: false })

export function parseMessage(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_BODY_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)
    || XMLValidator.validate(xml) !== true) throw new Error('Invalid XML')
  const message = parser.parse(xml)?.xml
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid XML envelope')
  return message
}

export function signature(...parts) {
  return createHash('sha1').update(parts.map(String).sort().join('')).digest('hex')
}

export function verifySignature(actual, ...parts) {
  if (!/^[a-f0-9]{40}$/.test(actual || '')) return false
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(signature(...parts), 'hex'))
}

/** WeChat timestamps are seconds; reject anything older or newer than 5 minutes. */
export function freshTimestamp(value, now = Date.now()) {
  return /^\d{10}$/.test(String(value)) && Math.abs(now / 1000 - Number(value)) <= 300
}

function aesKey(value) {
  if (!/^[a-zA-Z0-9+/]{43}$/.test(value || '')) throw new Error('Invalid AES key')
  return Buffer.from(value + '=', 'base64')
}

export function encryptMessage(message, appId, encodingKey) {
  const key = aesKey(encodingKey)
  const content = Buffer.from(message)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(content.length)
  const payload = Buffer.concat([randomBytes(16), length, content, Buffer.from(appId)])
  const padding = 32 - payload.length % 32
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64')
}

export function decryptMessage(encrypted, appId, encodingKey) {
  if (typeof encrypted !== 'string' || encrypted.length > MAX_BODY_BYTES || !/^[a-zA-Z0-9+/]+=*$/.test(encrypted)) throw new Error('Invalid ciphertext')
  const key = aesKey(encodingKey)
  const cipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const padded = Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64')), cipher.final()])
  const pad = padded[padded.length - 1]
  if (!pad || pad > 32 || !padded.subarray(-pad).every(v => v === pad)) throw new Error('Invalid padding')
  const data = padded.subarray(0, -pad)
  if (data.length < 20) throw new Error('Invalid payload')
  const length = data.readUInt32BE(16)
  if (20 + length > data.length || data.subarray(20 + length).toString() !== appId) throw new Error('Wrong app ID')
  return data.subarray(20, 20 + length).toString('utf8')
}

export const cdata = value => `<![CDATA[${String(value).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`

export function textReply(to, from, content, timestamp = Math.floor(Date.now() / 1000)) {
  return `<xml><ToUserName>${cdata(to)}</ToUserName><FromUserName>${cdata(from)}</FromUserName><CreateTime>${timestamp}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content>${cdata(content)}</Content></xml>`
}

export function encryptedReply(message, config, nonce, timestamp = Math.floor(Date.now() / 1000)) {
  const encrypted = encryptMessage(message, config.appId, config.aesKey)
  return `<xml><Encrypt>${cdata(encrypted)}</Encrypt><MsgSignature>${cdata(signature(config.token, timestamp, nonce, encrypted))}</MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce>${cdata(nonce)}</Nonce></xml>`
}

/** Per-site subject so partner sites never see the raw OpenID. */
export function siteSubject(codeSecret, namespace, openid) {
  return createHmac('sha256', codeSecret).update(JSON.stringify([namespace, openid])).digest('hex')
}
