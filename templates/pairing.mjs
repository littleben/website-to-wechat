// Code storage for official-account login, on PostgreSQL via the `postgres` package.
// Two flows share one table:
//   - login code: visitor sends a keyword, the account replies a 6-digit code (or a one-tap link)
//   - pairing:   the page shows a 6-digit code, the visitor sends it, the page signs in by itself
import { createHmac, randomBytes, randomInt } from 'node:crypto'

export const CODE_TTL_SECONDS = 300
export const PAIR_TTL_SECONDS = 600
export const PAIR_MESSAGE = /^(?:登录\s*)?(\d{6})$/

const hmac = (secret, value) => createHmac('sha256', secret).update(value).digest('hex')
const validSecret = secret => typeof secret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(secret)

/** Fixed-window limiter shared by all instances. Returns true while under `max`. */
export async function rateLimit(sql, bucket, max, seconds = 300) {
  const [row] = await sql`insert into wechat_rate_limits (bucket,window_start,attempts)
    values (${bucket},now(),1) on conflict (bucket) do update set
      attempts=case when wechat_rate_limits.window_start < now() - ${seconds} * interval '1 second' then 1 else wechat_rate_limits.attempts+1 end,
      window_start=case when wechat_rate_limits.window_start < now() - ${seconds} * interval '1 second' then now() else wechat_rate_limits.window_start end
    returning attempts`
  return row.attempts <= max
}

// ---------- login code (keyword → code / one-tap link) ----------

function codeFor(config, openid, msgId, index) {
  const digest = createHmac('sha256', config.codeSecret).update(JSON.stringify([config.namespace, openid, msgId, index])).digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}
const loginHash = (config, code) => hmac(config.codeSecret, `login-code:${code}`)

/**
 * Called from the webhook. Deterministic per MsgId so WeChat's retries of a slow
 * reply get the same code; consumed or expired codes are never revived.
 */
export async function issueLoginCode(sql, config, message) {
  const ns = config.namespace
  return sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${ns + ':' + message.FromUserName},0))`
    const [previous] = await tx`select * from wechat_login_codes where app_id=${ns} and message_id=${message.MsgId}`
    if (previous) {
      if (previous.consumed_at || previous.expires_at <= new Date()) return null
      return Array.from({ length: 32 }, (_, i) => codeFor(config, message.FromUserName, message.MsgId, i))
        .find(code => loginHash(config, code) === previous.code_hash) || null
    }
    if (!await rateLimit(tx, `issue:${hmac(config.codeSecret, ns + ':' + message.FromUserName)}`, 5)) return null
    // Keep the 6-digit space sparse.
    await tx`select pg_advisory_xact_lock(hashtextextended(${ns + ':issuance'},0))`
    const [{ count }] = await tx`select count(*)::int as count from wechat_login_codes
      where app_id=${ns} and consumed_at is null and expires_at>now()`
    if (count >= 100) return null
    // A new code retires this sender's older unused codes.
    await tx`update wechat_login_codes set consumed_at=now() where app_id=${ns} and openid=${message.FromUserName} and consumed_at is null`
    for (let i = 0; i < 32; i++) {
      const code = codeFor(config, message.FromUserName, message.MsgId, i)
      const inserted = await tx`insert into wechat_login_codes (app_id,message_id,openid,code_hash,expires_at)
        values (${ns},${message.MsgId},${message.FromUserName},${loginHash(config, code)},now()+${CODE_TTL_SECONDS}*interval '1 second')
        on conflict (code_hash) do nothing returning message_id`
      if (inserted.length) return code
    }
    return null
  })
}

/** Called by the site when the visitor types the code or opens the one-tap link. Returns the OpenID once. */
export async function consumeLoginCode(sql, config, code, browserKey) {
  if (!/^\d{6}$/.test(code || '')) return null
  if (!await rateLimit(sql, `verify:${config.namespace}:${hmac(config.codeSecret, browserKey || 'anon')}`, 5)) return null
  const [row] = await sql`update wechat_login_codes set consumed_at=now()
    where app_id=${config.namespace} and code_hash=${loginHash(config, code)}
      and consumed_at is null and expires_at>now() returning openid`
  return row?.openid || null
}

// ---------- pairing (page shows code → visitor sends it → page signs in) ----------

const pairNs = config => `${config.namespace}:pair`
const pairCodeHash = (config, code) => hmac(config.codeSecret, `pair-code:${code}`)
const pairRequestHash = (config, secret) => hmac(config.codeSecret, `pair-request:${secret}`)

/**
 * Called by the site. Put `request` in an HttpOnly cookie scoped to the pairing
 * endpoints and show `code` on the page. `browserKey` is an account id or a
 * first-party browser cookie, never the IP (behind a CDN it is the edge's).
 */
export async function createLoginPair(sql, config, browserKey) {
  if (browserKey && !await rateLimit(sql, `pair-create:${pairNs(config)}:${hmac(config.codeSecret, browserKey)}`, 10)) return null
  if (!await rateLimit(sql, `pair-create-global:${pairNs(config)}`, 3000)) return null
  const request = randomBytes(32).toString('base64url')
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = String(randomInt(1_000_000)).padStart(6, '0')
    const inserted = await sql`insert into wechat_login_codes (app_id,message_id,openid,code_hash,expires_at)
      values (${pairNs(config)},${pairRequestHash(config, request)},'pending',${pairCodeHash(config, code)},
        now()+${PAIR_TTL_SECONDS}*interval '1 second')
      on conflict (code_hash) do nothing returning message_id`
    if (inserted.length) return { code, request, expiresIn: PAIR_TTL_SECONDS }
  }
  return null
}

/** Called from the webhook when a text matches PAIR_MESSAGE. */
export async function pairLogin(sql, config, code, message) {
  if (!/^\d{6}$/.test(code)) return false
  if (!await rateLimit(sql, `pair-send:${pairNs(config)}:${hmac(config.codeSecret, message.FromUserName)}`, 10)) return false
  const hash = pairCodeHash(config, code)
  const [paired] = await sql`update wechat_login_codes set openid=${message.FromUserName}
    where app_id=${pairNs(config)} and code_hash=${hash} and openid='pending'
      and consumed_at is null and expires_at>now() returning message_id`
  if (paired) return true
  // WeChat retries a slow webhook with the same message; answer it the same way.
  const [replay] = await sql`select 1 from wechat_login_codes
    where app_id=${pairNs(config)} and code_hash=${hash} and openid=${message.FromUserName} and expires_at>now()`
  return Boolean(replay)
}

/**
 * Polled by the page (every 2 s visible, 6 s hidden). Claims once.
 * Compare times inside PostgreSQL: app-side clock or ORM date decoding can
 * report a live pair as expired.
 */
export async function claimLoginPair(sql, config, request) {
  if (!validSecret(request)) return { status: 'expired' }
  const hash = pairRequestHash(config, request)
  const [claimed] = await sql`update wechat_login_codes set consumed_at=now()
    where app_id=${pairNs(config)} and message_id=${hash} and openid<>'pending'
      and consumed_at is null and expires_at>now() returning openid`
  if (claimed) return { status: 'paired', openid: claimed.openid }
  const [row] = await sql`select openid,
      (openid='pending' and consumed_at is null) as pending,
      (openid<>'pending' and consumed_at >= now()-interval '60 seconds') as recoverable,
      greatest(1,floor(extract(epoch from (expires_at-now()))))::int as expires_in
    from wechat_login_codes where app_id=${pairNs(config)} and message_id=${hash} and expires_at>now()`
  if (row?.pending) return { status: 'pending', expiresIn: row.expires_in }
  // A lost response may be retried briefly; it still needs the 256-bit browser secret.
  if (row?.recoverable) return { status: 'paired', openid: row.openid }
  return { status: 'expired' }
}
