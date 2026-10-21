# 公众号消息回调

## 1. 后台配置

微信开发者平台 → 我的业务 → 公众号 → 消息与事件推送：

| 字段 | 值 |
|---|---|
| URL | `https://你的域名/api/wechat/webhook`（HTTPS 443） |
| Token | 随机 32 位，和服务端 `WECHAT_MP_TOKEN` 一致 |
| EncodingAESKey | 43 位，和 `WECHAT_MP_AES_KEY` 一致 |
| 消息加解密方式 | **安全模式** |
| 数据格式 | XML |

另外需要两个**不同的**字段，别搞混：

- `WECHAT_MP_APP_ID`：AppID（`wx` 开头），用于解密校验
- `WECHAT_MP_ORIGINAL_ID`：原始 ID（`gh_` 开头），用于校验 `ToUserName`
- 公众号「微信号」（如 `AI-Agent-X`）只用于展示，不能填到上面两个字段

消息验证码登录**不调用** access_token 接口，不需要 AppSecret，也不需要 IP 白名单。

生成密钥：

```sh
node -e "const c=require('crypto');console.log('TOKEN='+c.randomBytes(24).toString('base64url'));console.log('AES_KEY='+c.randomBytes(32).toString('base64').slice(0,43));console.log('CODE_SECRET='+c.randomBytes(32).toString('base64url'))"
```

## 2. 启用前必须做的迁移

**启用消息推送后，后台的自动回复和自定义菜单立即失效。**

1. 把欢迎语、每一条关键词回复（注意是「全匹配」还是「半匹配」）、默认回复、菜单文案原文抄下来，写进 `templates/replies.zh-CN.json`。
2. 菜单：个人未认证号通常**没有**创建菜单的接口权限（「接口权限与额度」页可查）。替代做法：让用户发送菜单名（如「关于作者」）触发同样的回复。
3. 图片、图文、语音类自动回复需要额外实现素材回复。只迁了文字就不要宣称完全兼容。

## 3. 请求处理顺序

```
GET  → 校验 timestamp(±300s)、nonce、signature / msg_signature → 原样返回 echostr（安全模式需解密）
POST → 拒绝非 encrypt_type=aes
     → 读 body（限 64KB）→ 解析外层 XML → 校验 ToUserName == 原始ID
     → 校验 msg_signature(token, timestamp, nonce, Encrypt)
     → AES-256-CBC 解密，校验尾部 AppID
     → 校验内层 ToUserName、CreateTime 新鲜度、FromUserName 格式
     → 路由：
        1. 文本 == 站点登录关键词         → 发 6 位验证码 / 一键登录链接
        2. 文本匹配 /^(登录\s*)?\d{6}$/   → 配对：把 openid 绑到等待中的配对码
        3. 文本匹配 下载口令              → 回下载链接
        4. event=subscribe                → 欢迎语
        5. event=CLICK                    → 菜单回复
        6. 其他文本                        → 旧关键词规则 → 菜单名 → 默认回复
     → 有内容：加密回复 XML；无内容：返回纯文本 success
```

实现见 `templates/webhook.mjs`，加解密见 `templates/wechat-crypto.mjs`。

## 4. 5 秒和幂等

- 微信 5 秒内收不到回复会**用同一个 MsgId 重试**，最多 3 次。
- 发码：同一个 MsgId 再来，返回同一个码（用 HMAC(secret, [appId, openid, msgId, i]) 确定性生成，查表比对 hash）；已消费或过期的不复活。
- 配对：同一 openid 重复发同一个配对码，回同样的「已登录」。
- 回调函数部署在**离数据库近**的区域，测一下冷启动。Vercel 上用 Node runtime，不要 Edge。

## 5. 安全

- 验证码、配对码只存 HMAC，不存明文；日志只记 outcome（`code_issued` / `rate_limited`），不记码、openid、IP。
- 限流放数据库（多实例共享）：每个 openid 5 分钟 5 次发码；全站同时有效码上限（如 100）；配对创建每个浏览器 5 分钟 10 次。
- 最新的码让同一 openid 之前未用的码失效。
- 一键登录链接：一次性 ticket，短有效期；用户**已登录**时打开链接必须二次确认再绑定。
- Cloudflare：给 `/api/wechat/webhook` 单独放行（不挑战、不缓存），不要关全站防护。应用自己做验签。

## 6. 多个网站共用一个公众号

- 回调只在一个服务上（「broker」）。
- 每个站点：独立关键词、独立命名空间 `appId + ':' + site`、独立 Bearer 密钥、固定的校验 URL（不接受调用方传目标地址）。
- broker 返回站点专属 subject：`HMAC_SHA256(codeSecret, JSON.stringify([appId:site, openid]))`，不返回原始 openid。
- 发错站点的码不消费。

## 7. 清理

每天删掉过期超过 1 天的码和限流记录（`delete from wechat_login_codes where expires_at < now() - interval '1 day'`）。身份映射永久保留。
