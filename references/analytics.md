# 埋点与转化率

## 事件

按项目现有埋点约定记录入口与语言。howtolivebetter 用 `placement` 区分 `book_download` / `sign_in` / `sync_dock` / `chapter` / `dashboard` 等入口，用 `locale` 标记语言；已有 `feature` / `language` 约定的项目可映射到同样的维度。分析时再按桌面、手机浏览器、微信内拆分，不传码、openid、昵称。

| 事件 | 含义 |
|---|---|
| `auth_prompt_shown` | 同步提醒真正展示 |
| `auth_prompt_open` | 登录/下载弹窗打开 |
| `auth_start` | 开始登录，记录 `method` 与入口 |
| `wechat_qr_view` | 通过可视区域观察器记录二维码曝光，每次组件激活只记一次 |
| `wechat_pair_start` | 拿到配对码 |
| `wechat_pair_resume` | 用户切回页面继续等待 |
| `wechat_open_app` | 点了「复制登录码并打开微信」 |
| `wechat_account_copy` | 复制公众号微信号 |
| `wechat_link_open` | 打开公众号回复的一键登录链接 |
| `wechat_pair_success` | 配对成功（桌面自动登录） |
| `wechat_code_error` | 手动输入的验证码错误/过期 |
| `wechat_reply_download` | 点击微信内「回复下载」的复制按钮 |
| `login` / `sign_up`（`method=wechat`） | 服务端确认成功后再发 |
| `sync_dock` | 同步入口的展开、收起或关闭操作 |
| `book_pdf_download` / `book_epub_download` 等 | 点击具体格式的下载链接 |
| `progress_sync`（`stage=success/error`） | 云端进度写入成功或失败 |

## 核心漏斗

```
下载/同步入口 → auth_prompt_open → auth_start → login(method=wechat) → 下载链接点击 / 进度同步成功
```

二维码曝光、开始配对、打开微信和一键链接打开用于诊断各分支，不要求每条路径经过同一组事件。微信内「回复下载」是单独的资料领取路径，也单独统计。

## 用数据定位要改的环节

| 观察到的情况 | 优先检查 |
|---|---|
| 入口有人看，打开引导的人少 | 下载/同步收益是否具体，入口是否出现在用户有需要的时刻 |
| 打开面板后没开始操作 | 是否看得懂在哪里发什么；手机是否只能看到一个扫不了自己的二维码 |
| 开始操作后登录失败 | 过期、验证码错误、网络错误，以及微信内切走后原页面无法继续的问题 |
| 登录成功，下载点击或同步成功少 | 是否回到原页面、保留所选格式、合并本机记录，是否有清楚的继续操作 |
| 同步入口频繁被关闭 | 提醒是否太早、太勤，关闭状态是否被正确保留 |

这些比较使用同一时间范围、同一数据源，并按入口、语言和浏览环境拆分。`wechat_link_open` 是链接打开，`wechat_pair_success` 是配对成功，两者次数之比不能当作登录人数之比；复制「下载」关键词和点击下载链接也分别只代表对应操作，文件是否完整下载需另有观测。

## 对照页面设计

参考 [登录与转化设计](login-design.md)，每次明确要改哪一个环节，再比较调整前后的完成情况。登录成功后仍要检查用户有没有完成最初的下载或保存任务。

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
