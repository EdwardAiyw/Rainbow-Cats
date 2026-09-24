# Rainbow-Cats Web Server

独立网页后端，使用 Node.js 18+、PostgreSQL 14+ 和原生 `web/` 客户端。浏览器只调用 `/api/v1`，不会直接访问数据库。

## 本地运行

```powershell
cd server
npm install
$env:DATABASE_URL='postgres://postgres:密码@127.0.0.1:5432/rainbow_cats'
$env:SESSION_SECRET='请替换为随机长字符串'
& 'D:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe' -v ON_ERROR_STOP=1 $env:DATABASE_URL -f schema.sql
npm start
```

打开 `http://localhost:3000`。生产环境必须使用 HTTPS、强随机 `SESSION_SECRET`、数据库备份和反向代理限流。

## 环境变量

- `PORT`：HTTP 端口，默认 `3000`
- `HOST`：监听地址，默认 `127.0.0.1`；生产环境由同机反向代理访问
- `DATABASE_URL`：PostgreSQL 连接串
- `SESSION_SECRET`：部署时使用的随机密钥
- `WEB_ORIGIN`：允许携带 Cookie 的网页来源
- `MAX_BODY_BYTES`：单个 JSON 请求体上限，默认 `65536`
- `TIANAPI_KEY`、`TIANAPI_DAILY_LIMIT`：可选，服务端代理菜谱搜索及每日限额
- `OPENCLAW_CHAT_URL`、`OPENCLAW_GATEWAY_TOKEN`：可选的独立 HTTP Gateway；两项都配置时优先使用
- `OPENCLAW_CHAT_CLI_ENABLED`：是否允许网页聊天通过本机 `openclaw infer model run --gateway` 推理；留空时继承 `OPENCLAW_RECIPE_ENABLED`
- `OPENCLAW_CHAT_MODEL`、`OPENCLAW_CHAT_DAILY_LIMIT`：网页聊天模型及全站每日请求上限，默认继承菜谱模型、每日 `100` 次
- `OPENCLAW_INTERNAL_TOKEN`：OpenClaw 本机插件调用 `/api/internal/openclaw/*` 的独立服务令牌；不要与网页会话令牌复用
- `OPENCLAW_IDENTITY_SECRET`：微信发送者身份索引的 HMAC 密钥；未配置时回退到 `SESSION_SECRET`
- `OPENCLAW_RECIPE_ENABLED`、`OPENCLAW_RECIPE_MODEL`、`OPENCLAW_RECIPE_DAILY_LIMIT`：TianAPI 无结果时的 OpenClaw 菜谱兜底及限额

## API 领域

认证：`/auth/create-space`、`/auth/join-space`、`/auth/login`、`/auth/recover`、`/auth/logout`。

业务：`/space`、`/missions`、`/market`、`/storage`、`/recipes`、`/calendar/events`、`/expenses`、`/budget`、`/album`、`/ai/proposals`。

写操作均在服务端校验空间成员身份并记录 `audit_logs`。AI 写操作先创建提案，网页确认后才执行对应事务。网页聊天会先尝试配置完整的独立 HTTP Gateway；未配置时可使用本机 CLI Gateway。CLI 模式只执行单次模型推理，不调用工具，业务写入仍只能通过网页提案确认。

微信渠道绑定：登录网页后调用 `/api/v1/channel-bindings/tokens` 生成一次性 6 位绑定码；OpenClaw 插件将可信的
`channel`、`agentAccountId` 和 `requesterSenderId` 传给仅限回环网络的 `/api/internal/openclaw/link`，服务端只保存
发送者身份的 HMAC 索引，不接受模型传入的 `userId` 或 `spaceId`。`/context` 按当前发送者返回双方身份、可用任务和礼物、本人收藏、近期日程、支出与菜谱快照。内部提案接口会返回一次性确认码，确认码过期、跨身份、重复使用或连续 5 次错误都不会写入业务数据。生产环境还必须在 Caddy/Nginx 层拒绝公网访问 `/api/internal/*`。

## 数据迁移和审计

`tools/migrate-cloudbase.js` 默认只做 dry-run；正式迁移前必须备份并安排停写窗口。`npm run audit:db` 只读检查空间成员、孤立记录和过期会话。

删除审计发现的无空间成员关系历史账号时，使用 `deploy/cleanup-orphan-users.sh <预期数量>`。脚本会先备份整库，并在单一事务内校验数量与业务引用；数量变化或仍有业务引用时不会删除。

## 测试

前端回归测试无需数据库或额外依赖：

```sh
npm run test:web
```

覆盖任务按钮状态、跨页缓存保留、并行加载失败、切页错误与重复点击、本地月份、菜谱来源链接和 OpenClaw 连接状态。

API 和完整浏览器测试必须使用隔离数据库。Windows 上的 UI smoke 会自行启动临时服务和 Headless Edge，创建的测试账号会在结束时删除：

```powershell
$env:DATABASE_URL='postgres://postgres:密码@127.0.0.1:5432/rainbow_cats_manual'
npm run check
npm run test:api
npm run test:ui
npm run test:ui-two-user
npm run audit:db
```

若 Edge 不在默认安装路径，通过 `EDGE_PATH` 指定可执行文件。UI smoke 会将桌面和 `390×844` 移动视口截图写入系统临时目录。

`rainbow.251104.xyz` 的生产脚本会从正式备份创建临时 PostgreSQL 数据库，并在副本上自动运行上述检查以及容器化 Playwright Chromium 验收；操作见 [`../deploy/README.zh-CN.md`](../deploy/README.zh-CN.md)。
