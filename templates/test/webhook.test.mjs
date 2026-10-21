import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decryptMessage, encryptMessage, parseMessage, signature, textReply } from '../wechat-crypto.mjs'
import { createWebhookHandler } from '../webhook.mjs'

const config = { appId: 'wx0000000000000000', originalId: 'gh_000000000000', token: 'test-token', aesKey: 'a'.repeat(43) }
const now = () => String(Math.floor(Date.now() / 1000))

function incoming(inner, { tamper = false } = {}) {
  const ts = now(), nonce = 'n123'
  const encrypted = encryptMessage(inner, config.appId, config.aesKey)
  const sig = signature(config.token, ts, nonce, tamper ? encrypted + 'x' : encrypted)
  const url = `https://site.test/api/wechat/webhook?timestamp=${ts}&nonce=${nonce}&encrypt_type=aes&msg_signature=${sig}`
  return new Request(url, { method: 'POST', body: `<xml><ToUserName><![CDATA[${config.originalId}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>` })
}
const text = (content, msgId = '1001') =>
  `<xml><ToUserName><![CDATA[${config.originalId}]]></ToUserName><FromUserName><![CDATA[oUser_1]]></FromUserName><CreateTime>${now()}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>${msgId}</MsgId></xml>`
async function replyText(response) {
  const outer = parseMessage(await response.text())
  return parseMessage(decryptMessage(outer.Encrypt, config.appId, config.aesKey)).Content
}

const calls = []
const handler = createWebhookHandler({
  config,
  loginKeywords: ['登录'],
  onLoginKeyword: async m => { calls.push(['login', m.FromUserName]); return 'CODE 123456' },
  onPairCode: async (m, code) => { calls.push(['pair', code]); return 'paired ' + code },
  replies: { subscribe: 'welcome', keywords: [{ keyword: '教程', mode: 'exact', reply: 'tutorial link' }], menus: [{ name: '关于作者', key: 'ABOUT', reply: 'about' }] },
})

test('crypto round trip and app id check', () => {
  const xml = textReply('a', 'b', '你好')
  assert.equal(decryptMessage(encryptMessage(xml, config.appId, config.aesKey), config.appId, config.aesKey), xml)
  assert.throws(() => decryptMessage(encryptMessage(xml, 'wxOTHER', config.aesKey), config.appId, config.aesKey))
})

test('URL verification (plain signature)', async () => {
  const ts = now(), nonce = 'abc'
  const res = await handler(new Request(`https://s.test/w?timestamp=${ts}&nonce=${nonce}&echostr=hello&signature=${signature(config.token, ts, nonce)}`))
  assert.equal(await res.text(), 'hello')
})

test('login keyword, pairing code, old keyword, menu name', async () => {
  assert.equal(await replyText(await handler(incoming(text(' 登录 ')))), 'CODE 123456')
  assert.equal(await replyText(await handler(incoming(text('482917')))), 'paired 482917')
  assert.equal(await replyText(await handler(incoming(text('登录 482917')))), 'paired 482917')
  assert.equal(await replyText(await handler(incoming(text('教程')))), 'tutorial link')
  assert.equal(await replyText(await handler(incoming(text('关于作者')))), 'about')
})

test('unknown text without default replies success', async () => {
  assert.equal(await (await handler(incoming(text('随便说说')))).text(), 'success')
})

test('rejects bad signature and plaintext mode', async () => {
  const before = calls.length
  assert.equal((await handler(incoming(text('登录'), { tamper: true }))).status, 403)
  const ts = now()
  const res = await handler(new Request(`https://s.test/w?timestamp=${ts}&nonce=n&signature=${signature(config.token, ts, 'n')}`, { method: 'POST', body: text('登录') }))
  assert.equal(res.status, 403)
  assert.equal(calls.length, before, 'no code issued for rejected messages')
})
