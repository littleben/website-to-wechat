// Integration test against a real PostgreSQL. Skipped unless TEST_DATABASE_URL is set:
//   docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=pw --name wx-pg postgres:16
//   TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { claimLoginPair, consumeLoginCode, createLoginPair, issueLoginCode, pairLogin } from '../pairing.mjs'

const url = process.env.TEST_DATABASE_URL
const config = { namespace: 'wxtest:site', codeSecret: 's'.repeat(43) }
let sql

before(async () => {
  if (!url) return
  sql = postgres(url, { onnotice: () => {} })
  await sql.unsafe('drop table if exists wechat_login_codes, wechat_rate_limits, wechat_identities')
  await sql.unsafe(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))
})
after(async () => { await sql?.end() })

test('pairing: only the starting browser claims, once', { skip: !url }, async () => {
  const pair = await createLoginPair(sql, config, 'browser-1')
  assert.match(pair.code, /^\d{6}$/)
  assert.equal((await claimLoginPair(sql, config, pair.request)).status, 'pending')
  assert.equal(await pairLogin(sql, config, pair.code, { FromUserName: 'oUser', MsgId: '1' }), true)
  assert.equal(await pairLogin(sql, config, pair.code, { FromUserName: 'oUser', MsgId: '1' }), true, 'retry answered the same')
  assert.equal(await pairLogin(sql, config, pair.code, { FromUserName: 'oOther', MsgId: '2' }), false)
  assert.equal((await claimLoginPair(sql, config, 'x'.repeat(43))).status, 'expired', 'wrong secret')
  const claimed = await claimLoginPair(sql, config, pair.request)
  assert.deepEqual(claimed, { status: 'paired', openid: 'oUser' })
  await sql`update wechat_login_codes set consumed_at = now() - interval '2 minutes' where openid = 'oUser'`
  assert.equal((await claimLoginPair(sql, config, pair.request)).status, 'expired', 'no second claim')
})

test('login code: same MsgId same code, one use, newer code retires older', { skip: !url }, async () => {
  const m1 = { FromUserName: 'oA', MsgId: '100' }
  const code = await issueLoginCode(sql, config, m1)
  assert.equal(await issueLoginCode(sql, config, m1), code, 'WeChat retry gets the same code')
  const newer = await issueLoginCode(sql, config, { FromUserName: 'oA', MsgId: '101' })
  assert.equal(await consumeLoginCode(sql, config, code, 'b1'), null, 'older code retired')
  assert.equal(await consumeLoginCode(sql, config, newer, 'b1'), 'oA')
  assert.equal(await consumeLoginCode(sql, config, newer, 'b1'), null, 'single use')
  assert.equal(await issueLoginCode(sql, config, m1), null, 'consumed code never revived')
})
