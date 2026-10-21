# website-to-wechat

把网站访客变成公众号粉丝的 Agent Skill：**公众号关注即登录**。

访客在网站上想下载 / 保存 / 同步，登录方式只给公众号：关注 → 发一个码 → 网站自动登录。每一次登录，都是一次关注加一次私信对话。

- ✅ 个人**未认证订阅号**可用（只用到消息推送，不需要认证服务号、开放平台网站应用、AppSecret）
- ✅ 桌面 / 手机浏览器 / 微信内置浏览器三条路径分别处理
- ✅ 一个公众号服务多个网站（关键词 + 命名空间隔离）
- ✅ 附带生产代码提炼的参考实现：加解密、回调、配对码、限流、测试

## 真实数据

[howtolivebetter.net](https://howtolivebetter.net)（《高性价比人生指南》在线版），2026-10-02 上线公众号登录，到 10-21 共 19 天：

| 指标 | 数值 |
|---|---|
| 完成公众号登录 | **13,357 人** |
| 新用户中走微信登录 | 98% |
| 二维码曝光来自下载弹窗 | 72% |
| 一键登录链接 : 桌面配对 | 约 2 : 1 |

详见 [references/case-howtolivebetter.md](references/case-howtolivebetter.md)。

## 安装

Claude Code：

```sh
git clone https://github.com/littleben/website-to-wechat ~/.claude/skills/website-to-wechat
```

Codex / 其他支持 Agent Skills 的工具：把仓库放进对应的 skills 目录即可。不用 Agent 也可以直接读 `SKILL.md` 照着做。

然后对 Agent 说：

> 用 website-to-wechat skill，给我的网站加上公众号登录，下载 PDF 必须登录。

## 目录

```
SKILL.md                       主流程（Agent 读这个）
references/
  funnel.md                    诱饵、入口位置、三种环境的界面和文案
  webhook.md                   消息推送配置、迁移旧自动回复、5 秒与幂等、安全
  analytics.md                 漏斗埋点、GA 与数据库对账
  launch-checklist.md          真机验收清单
  case-howtolivebetter.md      案例数据和踩坑
templates/
  wechat-crypto.mjs            安全模式加解密、签名、回复 XML
  webhook.mjs                  框架无关的回调处理（Request → Response）
  pairing.mjs                  验证码 / 配对码存储与限流（PostgreSQL）
  example-routes.mjs           Next.js 路由接法示例
  wechat-browser.ts            环境判断、记住返回页、轮询
  schema.sql                   新增表
  replies.zh-CN.json           旧自动回复迁移模板
  test/                        node:test（配对测试需要 TEST_DATABASE_URL）
```

## 跑测试

```sh
cd templates && npm install
npm test                                   # 加解密 + 回调
docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=pw --name wx-pg postgres:16
TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npm test   # 加上配对/验证码
```

## ⚠️ 启用前一定要知道

启用公众号「消息推送」后，**后台配置的自动回复和自定义菜单会立刻失效**。先把原文备份进 `replies.zh-CN.json`。

## 作者

Ben（[@littlebena](https://x.com/littlebena)），公众号「AI工具进化论」。

MIT License
