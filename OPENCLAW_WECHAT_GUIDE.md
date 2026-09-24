# Rainbow-Cats × OpenClaw 微信助手

这份文档只覆盖仓库内已经实现的接口和生产部署边界。服务器地址、Cloudflare、微信扫码账号和 DeepSeek 密钥必须在部署时由管理员交互式填写，不要写入仓库。

## 已实现的链路

1. 两位成员分别登录自己的网页账号，在“设置 → 连接微信助手”生成各自的一次性 6 位绑定码（10 分钟有效）。
2. 本人在 AI_1 私聊发送自己的绑定码；对象在小暖私聊发送对方账号生成的绑定码。
3. OpenClaw 微信插件把运行时提供的可信渠道、机器人账号和发送者身份连同绑定码发送到回环接口：
   `POST http://127.0.0.1:3101/api/internal/openclaw/link`
4. 绑定成功后，查询使用 `/context`；创建写操作提案使用 `/proposals`；当前发送者在同一私聊中回复确认码后使用 `/confirm`。
5. 所有内部请求必须带 `X-OpenClaw-Internal-Token`（或 Bearer 令牌），并且只能从本机回环地址访问。模型不能提交 `userId`、`spaceId` 或伪造微信身份。

## 身份规则

```text
当前微信发送者
→ 当前机器人账号（AI_1 或小暖）
→ 该私聊的独立渠道绑定
→ 该发送者的 Rainbow-Cats 网页用户
→ 双方共同的双人空间
```

- “我”和“我的”始终指当前微信发送者绑定的网页用户。
- “我们”指两位网页用户共同的双人空间。
- AI_1 和小暖只是机器人账号，不是网页用户，不能自选用户或代替另一人确认。
- 任务、礼物等业务 ID 只用于工具调用，机器人不应在普通回复中展示 UUID。

接口请求示例（字段值仅为格式示例）：

```json
{
  "channel": "openclaw-weixin",
  "agentAccountId": "assistant-account",
  "requesterSenderId": "wechat-sender-id"
}
```

提案确认码为一次性 6 位数字，过期、身份不匹配或重复确认都不会写入业务数据。连续 5 次错误后提案会被拒绝，过期提案会标记为 `expired`。部署前先执行 `server/schema.sql`。

## 服务端环境变量

在受限的 systemd/Caddy 环境文件中配置：

- `DATABASE_URL`、`SESSION_SECRET`、`WEB_ORIGIN=https://rainbow.251104.xyz`
- `OPENCLAW_INTERNAL_TOKEN`：仅 Rainbow 服务和本机 OpenClaw 插件共享
- `OPENCLAW_IDENTITY_SECRET`：发送者身份 HMAC 密钥
- `OPENCLAW_CHAT_URL`、`OPENCLAW_GATEWAY_TOKEN`：网页 AI 对话代理（可选）
- `DEEPSEEK_API_KEY`：由 OpenClaw 模型提供商配置使用（不要提交到仓库）

## Caddy 边界

Rainbow 服务只监听 `127.0.0.1:3101`，OpenClaw Gateway 只监听 `127.0.0.1:18789`，PostgreSQL 只允许本机访问。Caddy 对外提供 `https://rainbow.251104.xyz`，并拒绝内部接口：

```caddyfile
rainbow.251104.xyz {
  @internal path /api/internal/*
  respond @internal 404
  reverse_proxy 127.0.0.1:3101
}
```

Cloudflare DNS 仅保持 `rainbow` 子域名的 A 记录指向服务器；主域名已有站点不要改动。启用 Full (strict) 后再验证 HTTP 到 HTTPS 跳转。

## 部署与验收

```powershell
cd server
npm ci
$env:DATABASE_URL='postgres://...'
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f schema.sql
npm run check
npm run test:api
npm run audit:db
```

生产验收至少覆盖：绑定码过期/重复使用、错误确认码次数限制、跨空间身份拒绝、重复确认只执行一次、`/api/internal/*` 公网不可达，以及 Gateway/DeepSeek 不可用时不产生半完成事务。真实微信扫码和 DNS/证书验证必须在目标服务器上完成。
