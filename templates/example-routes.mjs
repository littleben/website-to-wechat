// Wiring example for a single site (callback and site in one service), Next.js App Router style.
// Split into files under app/api/wechat/... ; all routes need `export const runtime = 'nodejs'`.
import postgres from 'postgres'
import { createWebhookHandler } from './webhook.mjs'
import { claimLoginPair, consumeLoginCode, createLoginPair, issueLoginCode, pairLogin } from './pairing.mjs'
import { siteSubject } from './wechat-crypto.mjs'
import replies from './replies.zh-CN.json' with { type: 'json' }

const sql = postgres(process.env.DATABASE_URL)
const SITE = process.env.SITE_URL                       // https://example.com
const config = {
  appId: process.env.WECHAT_MP_APP_ID,                  // wx...
  originalId: process.env.WECHAT_MP_ORIGINAL_ID,        // gh_...
  token: process.env.WECHAT_MP_TOKEN,
  aesKey: process.env.WECHAT_MP_AES_KEY,                // 43 chars
  codeSecret: process.env.WECHAT_MP_CODE_SECRET,        // ≥ 32 random bytes
}
config.namespace = `${config.appId}:mysite`             // one namespace per site sharing the account

// ---- app/api/wechat/webhook/route.js ----
export const webhook = createWebhookHandler({
  config,
  replies,
  loginKeywords: ['登录'],
  async onLoginKeyword(message) {
    const code = await issueLoginCode(sql, config, message)
    if (!code) return '请求太频繁，请 5 分钟后再试。'
    // The link is for visitors reading this inside WeChat: tapping it signs them in on the spot.
    return `登录验证码：${code}（5 分钟有效）\n\n在微信里浏览？直接点：${SITE}/wechat-login?code=${code}`
  },
  async onPairCode(message, code) {
    return await pairLogin(sql, config, code, message)
      ? '已登录，回到网页即可。'
      : '登录码无效或已过期，请在网页上获取新的登录码。'
  },
})
// export const GET = webhook; export const POST = webhook

// ---- app/api/wechat/pair/route.js ----
// POST {action:'create'} → sets cookie, returns {code, expiresIn}
// POST {action:'claim'}  → reads cookie, returns {status} and signs in when paired
export async function pair(request, { browserKey, signIn }) {
  const { action } = await request.json()
  if (action === 'create') {
    const pair = await createLoginPair(sql, config, browserKey)
    if (!pair) return Response.json({ ok: false, reason: 'rate_limited' }, { status: 429 })
    return Response.json({ ok: true, code: pair.code, expiresIn: pair.expiresIn }, {
      headers: { 'Set-Cookie': `wx_pair=${pair.request}; Max-Age=${pair.expiresIn}; Path=/api/wechat/pair; HttpOnly; Secure; SameSite=Lax`, 'Cache-Control': 'no-store' },
    })
  }
  if (action === 'claim') {
    const secret = /(?:^|; )wx_pair=([^;]+)/.exec(request.headers.get('cookie') || '')?.[1]
    const result = await claimLoginPair(sql, config, secret)
    if (result.status !== 'paired') return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } })
    // Find or create the user by this subject, then create your normal session.
    return signIn(siteSubject(config.codeSecret, config.namespace, result.openid))
  }
  return Response.json({ ok: false }, { status: 400 })
}

// ---- app/api/wechat/verify/route.js (typed code or one-tap link) ----
export async function verify(request, { browserKey, signIn, currentUser }) {
  const { code, confirmBind } = await request.json()
  const openid = await consumeLoginCode(sql, config, code, browserKey)
  if (!openid) return Response.json({ ok: false, reason: 'invalid_or_expired' }, { status: 400 })
  // Never bind silently: a signed-in visitor opening a one-tap link must confirm first.
  if (currentUser && !confirmBind) return Response.json({ ok: false, reason: 'confirm_bind' }, { status: 409 })
  return signIn(siteSubject(config.codeSecret, config.namespace, openid), currentUser)
}
