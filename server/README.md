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
- `DATABASE_URL`：PostgreSQL 连接串
- `SESSION_SECRET`：部署时使用的随机密钥
- `WEB_ORIGIN`：允许携带 Cookie 的网页来源
- `TIANAPI_KEY`：可选，服务端代理菜谱搜索
- `OPENCLAW_CHAT_URL`、`OPENCLAW_GATEWAY_TOKEN`：可选，服务端代理 OpenClaw 聊天
- `OPENCLAW_INTERNAL_TOKEN`：OpenClaw 本机插件调用 `/api/internal/openclaw/*` 的独立服务令牌；不要与网页会话令牌复用
- `OPENCLAW_IDENTITY_SECRET`：微信发送者身份索引的 HMAC 密钥；未配置时回退到 `SESSION_SECRET`

## API 领域

认证：`/auth/create-space`、`/auth/join-space`、`/auth/login`、`/auth/recover`、`/auth/logout`。

业务：`/space`、`/missions`、`/market`、`/storage`、`/recipes`、`/calendar/events`、`/expenses`、`/budget`、`/album`、`/ai/proposals`。

写操作均在服务端校验空间成员身份并记录 `audit_logs`。AI 写操作先创建提案，网页确认后才执行对应事务。

微信渠道绑定：登录网页后调用 `/api/v1/channel-bindings/tokens` 生成一次性 6 位绑定码；OpenClaw 插件将可信的
`channel`、`agentAccountId` 和 `requesterSenderId` 传给仅限回环网络的 `/api/internal/openclaw/link`，服务端只保存
发送者身份的 HMAC 索引，不接受模型传入的 `userId` 或 `spaceId`。内部提案接口会返回一次性确认码，确认码过期或重复使用
不会写入业务数据。生产环境还必须在 Caddy/Nginx 层拒绝公网访问 `/api/internal/*`。

## 数据迁移和审计

`tools/migrate-cloudbase.js` 默认只做 dry-run；正式迁移前必须备份并安排停写窗口。`npm run audit:db` 只读检查空间成员、孤立记录和过期会话。

## 测试

前端回归测试无需数据库或额外依赖：

```sh
npm run test:web
```

覆盖任务按钮状态、跨页缓存保留、并行加载失败、切页错误与重复点击、本地月份和菜谱来源链接。

API 和完整浏览器测试必须使用隔离数据库。Windows 上的 UI smoke 会自行启动临时服务和 Headless Edge，创建的测试账号会在结束时删除：

```powershell
$env:DATABASE_URL='postgres://postgres:密码@127.0.0.1:5432/rainbow_cats_manual'
npm run check
npm run test:api
npm run test:ui
npm run audit:db
```

若 Edge 不在默认安装路径，通过 `EDGE_PATH` 指定可执行文件。UI smoke 会将桌面和 `390×844` 移动视口截图写入系统临时目录。
