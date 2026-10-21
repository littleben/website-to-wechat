# 埋点与转化率

## 事件

所有事件带 `feature`（入口：book_download / sign_in / sync / chapter / dashboard…）和 `language`。不传码、openid、昵称。

| 事件 | 含义 |
|---|---|
| `auth_prompt_open` | 登录/下载弹窗打开 |
| `wechat_qr_view` | 公众号二维码真正渲染出来 |
| `wechat_pair_start` | 拿到配对码 |
| `wechat_pair_resume` | 用户切回页面继续等待 |
| `wechat_open_app` | 点了「复制登录码并打开微信」 |
| `wechat_account_copy` | 复制公众号微信号 |
| `wechat_link_open` | 打开公众号回复的一键登录链接 |
| `wechat_pair_success` | 配对成功（桌面自动登录） |
| `wechat_code_error` | 手动输入的验证码错误/过期 |
| `wechat_reply_download` | 微信内选择「回复下载」 |
| `login` / `sign_up`（`method=wechat`） | 服务端确认成功后再发 |

## 核心漏斗

```
入口曝光 → wechat_qr_view → (wechat_pair_start | wechat_open_app) → login(method=wechat)
```

## 用数据库对账

GA4 会少记（拦截器、隐私浏览器、页面跳走太快）。howtolivebetter 实测 GA 只记到数据库真实注册的约 68%。所以：

- **真实结果看数据库**：`select count(*) from account where provider_id='wechat-mp'`，按天分组看增长。
- **路径占比看 GA**：比例在 GA 内部比较是可靠的。
- 数据库里「第一个 account 是 wechat 的新用户 / 全部新用户」= 微信登录在新用户里的占比。

```sql
-- 每天新增微信身份
select date_trunc('day', created_at at time zone 'Asia/Shanghai') d, count(*)
from account where provider_id = 'wechat-mp' group by 1 order by 1;

-- 新用户的首个登录方式
select p, count(*) from (
  select u.id, (select provider_id from account a where a.user_id = u.id order by a.created_at limit 1) p
  from "user" u where u.created_at >= '上线日期'
) t group by 1;
```

## 和公众号后台对账

数据库里的微信身份数 ≈ 通过网站给公众号发过消息的人数，**不等于**新增关注：原来就关注的老粉丝也会来登录。到公众号后台「用户分析」看同期新增关注和取消关注，两边一起看。
