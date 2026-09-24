# Rainbow-Cats｜我们的双人生活空间

> 把心愿、礼物、菜谱、日程、账本、照片与 AI 助手放进一个只属于两个人的空间。

[![Production](https://img.shields.io/badge/production-online-2f855a)](https://rainbow.251104.xyz)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-43853d?logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-4169e1?logo=postgresql&logoColor=white)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Rainbow-Cats 是一个面向伴侣、家人或固定搭档的双人生活管理应用。两位成员通过邀请码进入同一个空间，共同记录生活，并通过心愿积分和礼物兑换形成轻量、可持续的互动。

当前产品主线是原生 Web 客户端 `web/` 与 Node.js + PostgreSQL 服务端 `server/`。早期微信小程序及云函数代码仍保留在仓库中，用于历史归档和迁移参考，但不再是正式产品入口。

- 在线站点：<https://rainbow.251104.xyz>
- 使用说明书：[docs/使用说明书.md](docs/使用说明书.md)
- 使用说明：[USER_GUIDE.md](USER_GUIDE.md)
- 服务端文档：[server/README.md](server/README.md)
- 生产发布：[deploy/README.zh-CN.md](deploy/README.zh-CN.md)

> [!IMPORTANT]
> 在线站点承载真实的个人生活数据，不提供公共演示账号。自行试用时请创建自己的双人空间，并妥善保存首次生成的一次性恢复码。

## 目录

- [核心功能](#核心功能)
- [业务规则](#业务规则)
- [系统架构](#系统架构)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [测试](#测试)
- [生产部署](#生产部署)
- [安全设计](#安全设计)
- [项目结构](#项目结构)
- [历史小程序](#历史小程序)
- [文档导航](#文档导航)
- [许可证](#许可证)

## 核心功能

| 模块 | 能力 |
| --- | --- |
| 双人空间 | 创建空间、邀请码加入、最多两位成员、共享空间概览 |
| 账号体系 | 用户名和密码登录、30 天会话、一次性恢复码重置密码 |
| 心愿与任务 | 发布带积分的心愿，由另一位成员完成并为发布者增加积分 |
| 礼物与收藏 | 上架礼物、使用积分兑换、进入个人收藏并记录使用状态 |
| 菜谱 | 保存自建菜谱；可选接入 TianAPI 搜索，并使用 OpenClaw 作为兜底 |
| 日程 | 创建共享日程；可选连接个人 CalDAV 并同步未来 90 天事件 |
| 账本 | 记录共同支出、分类与日期，设置并查看每月预算进度 |
| 相册 | 保存图片 URL、说明、拍摄时间与元数据；当前不负责二进制文件托管 |
| AI 助手 | 通过 OpenClaw 对话生成任务、礼物、支出或日程等待确认提案 |
| 微信助手 | 将可信微信发送者身份绑定到网页账号，在微信中查询或发起待确认操作 |
| 设置与隐私 | 修改昵称、设置旧账号登录信息、管理微信绑定、永久删除账号 |

界面采用响应式原生 HTML/CSS/JavaScript：桌面端使用侧边导航，移动端切换为底部导航，无前端构建步骤。

## 业务规则

- 每个空间最多两位成员，第二位成员使用邀请码加入。
- 积分范围为 `0–500`。
- 不能完成自己发布的心愿，也不能兑换自己发布的礼物。
- 完成心愿后，积分发给心愿发布者；兑换礼物时从兑换者积分中扣除。
- 礼物兑换后进入兑换者的个人收藏，收藏仅本人可见和使用。
- AI 不直接执行写操作。模型只能回答或创建待确认提案，用户确认后服务端才在事务中写入。
- 创建空间或加入空间时生成的恢复码只展示一次，请离线保存。

## 系统架构

```mermaid
flowchart TD
    User([👥 两位成员]) -->|HTTPS| Web[🌐 原生 Web 客户端<br/>HTML · CSS · JavaScript]
    Web -->|REST /api/v1<br/>Cookie 或 Bearer Token| Server[⚙️ Node.js 服务端<br/>认证 · 业务规则 · 静态资源]
    Server -->|参数化 SQL 与事务| DB[(💾 PostgreSQL)]

    Server -.->|可选：菜谱搜索| TianAPI[🍳 TianAPI]
    Server -.->|可选：日历同步| CalDAV[📅 CalDAV 服务]
    Server -.->|可选：HTTP 或本机 CLI| OpenClaw[🤖 OpenClaw Gateway]
    WeChat[💬 微信私聊] -.->|可信运行时身份| Plugin[🔌 OpenClaw 插件]
    Plugin -.->|仅回环网络 /api/internal| Server

    classDef client fill:#FFE8EC,stroke:#9B5C6B,stroke-width:2px,color:#3D2930
    classDef service fill:#DFF4EA,stroke:#377B63,stroke-width:2px,color:#173E31
    classDef data fill:#E4EEFF,stroke:#4169A1,stroke-width:2px,color:#1B3157
    classDef optional fill:#FFF3D6,stroke:#9A7427,stroke-width:2px,color:#4B3810

    class User,Web,WeChat client
    class Server,Plugin service
    class DB data
    class TianAPI,CalDAV,OpenClaw optional
```

核心边界：浏览器不直接访问数据库；所有业务读取和写入都经过服务端 API。微信助手也不能指定任意 `userId` 或 `spaceId`，只能使用服务端根据可信发送者身份解析出的账号和空间。

## 技术栈

| 层级 | 实现 |
| --- | --- |
| 前端 | 原生 HTML、CSS、JavaScript，响应式单页界面 |
| 服务端 | Node.js 18+，原生 `http` 模块 |
| 数据库 | PostgreSQL 14+，`pg` 驱动，`pgcrypto` 扩展 |
| 日历 | `tsdav`，CalDAV Basic Auth |
| AI | OpenClaw HTTP Gateway 或本机 CLI Gateway，可选接入 |
| 菜谱 | TianAPI，可选；OpenClaw 可作为搜索兜底 |
| 部署 | Docker、Docker Compose、Caddy、只读应用容器 |
| 测试 | Node.js Test Runner、API/UI smoke、Headless Edge、Playwright 生产验收 |

## 快速开始

### 环境要求

- Node.js `18+`
- PostgreSQL `14+`
- `psql` 命令行客户端
- Git

只有服务端目录需要安装依赖，前端无需构建。

### 1. 克隆仓库并安装依赖

```powershell
git clone https://github.com/EdwardAiyw/Rainbow-Cats.git
cd Rainbow-Cats\server
npm install
```

在 CI 或依赖锁定的环境中可使用 `npm ci`。

### 2. 创建数据库

先在 PostgreSQL 中创建空数据库和可访问该数据库的用户。下面仅给出本地示例，请替换用户名、密码和端口：

```powershell
$env:DATABASE_URL = 'postgres://postgres:你的密码@127.0.0.1:5432/rainbow_cats'
psql -v ON_ERROR_STOP=1 $env:DATABASE_URL -f schema.sql
```

如果 `psql` 未加入 `PATH`，可使用完整路径：

```powershell
& 'D:\Program Files\PostgreSQL\18\bin\psql.exe' `
  -v ON_ERROR_STOP=1 `
  $env:DATABASE_URL `
  -f schema.sql
```

Linux / macOS：

```bash
export DATABASE_URL='postgres://postgres:your-password@127.0.0.1:5432/rainbow_cats'
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f schema.sql
```

`schema.sql` 使用可重复执行的 `CREATE ... IF NOT EXISTS` 和增量 `ALTER TABLE` 语句，可用于新数据库初始化和现有部署升级。

### 3. 配置并启动服务

PowerShell：

```powershell
$env:DATABASE_URL = 'postgres://postgres:你的密码@127.0.0.1:5432/rainbow_cats'
$env:SESSION_SECRET = '请替换为足够长的随机字符串'
$env:WEB_ORIGIN = 'http://localhost:3000'
$env:HOST = '127.0.0.1'
$env:PORT = '3000'
npm start
```

Linux / macOS：

```bash
export DATABASE_URL='postgres://postgres:your-password@127.0.0.1:5432/rainbow_cats'
export SESSION_SECRET='replace-with-a-long-random-value'
export WEB_ORIGIN='http://localhost:3000'
export HOST='127.0.0.1'
export PORT='3000'
npm start
```

浏览器打开 <http://localhost:3000>。健康检查地址为 <http://localhost:3000/api/v1/health>。

### 4. 创建双人空间

1. 第一位成员选择“创建空间”，设置昵称、用户名和至少 8 位密码。
2. 保存页面只展示一次的恢复码。
3. 将空间邀请码发给第二位成员。
4. 第二位成员选择“加入空间”，填写邀请码并创建自己的账号。

用户名仅支持 `3–40` 位小写字母、数字或下划线。

## 环境变量

基础模板见 [`server/.env.example`](server/.env.example)。当前服务不会自动读取 `.env` 文件；本地运行时请在 shell 中导出变量，生产环境由 systemd、容器或部署平台注入。

### 必需或基础配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 无 | PostgreSQL 连接串；运行服务时必须配置 |
| `SESSION_SECRET` | 开发占位值 | 会话相关密钥，也用于加密 CalDAV 凭据；生产环境必须替换 |
| `WEB_ORIGIN` | `http://localhost:3000` | 允许携带凭据访问 API 的网页来源；HTTPS 来源会启用 Secure Cookie |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `3000` | HTTP 监听端口 |
| `MAX_BODY_BYTES` | `65536` | 单个 JSON 请求体上限，单位为字节 |

### 可选集成

| 变量 | 说明 |
| --- | --- |
| `TIANAPI_KEY` | TianAPI 菜谱接口密钥；不配置时跳过官方接口 |
| `TIANAPI_DAILY_LIMIT` | TianAPI 每日全站请求上限，默认 `95` |
| `OPENCLAW_CHAT_URL` | 独立 OpenClaw HTTP Gateway 地址 |
| `OPENCLAW_GATEWAY_TOKEN` | HTTP Gateway 令牌；与 URL 同时配置后优先使用 HTTP 模式 |
| `OPENCLAW_CHAT_CLI_ENABLED` | 是否允许通过本机 OpenClaw CLI 提供网页聊天 |
| `OPENCLAW_CHAT_MODEL` | 网页聊天模型 |
| `OPENCLAW_CHAT_DAILY_LIMIT` | 网页聊天每日全站请求上限，默认 `100` |
| `OPENCLAW_RECIPE_ENABLED` | 是否允许 OpenClaw 作为菜谱搜索兜底 |
| `OPENCLAW_RECIPE_MODEL` | 菜谱兜底模型 |
| `OPENCLAW_RECIPE_DAILY_LIMIT` | 菜谱兜底每日全站请求上限，默认 `20` |
| `OPENCLAW_INTERNAL_TOKEN` | 本机插件访问内部 API 的独立服务令牌 |
| `OPENCLAW_IDENTITY_SECRET` | 微信发送者身份索引的 HMAC 密钥；未配置时回退到 `SESSION_SECRET` |

完整说明及接口领域见 [server/README.md](server/README.md)。任何密钥都不应提交到仓库。

## 测试

在 `server/` 目录执行：

```powershell
npm run check
npm run test:web
```

`test:web` 不需要数据库，覆盖前端关键状态、跨页缓存、错误处理、本地月份、菜谱来源链接和 OpenClaw 状态等回归场景。

API、浏览器和数据库审计必须使用隔离数据库：

```powershell
$env:DATABASE_URL = 'postgres://postgres:你的密码@127.0.0.1:5432/rainbow_cats_test'
psql -v ON_ERROR_STOP=1 $env:DATABASE_URL -f schema.sql

npm run test:api
npm run test:ui
npm run test:ui-two-user
npm run audit:db
```

Windows UI smoke 默认调用 Headless Edge；非默认安装位置可通过 `EDGE_PATH` 指定。更完整的手工检查、双人会话和移动端验收见 [WEB_TEST_GUIDE.md](WEB_TEST_GUIDE.md)。

> [!CAUTION]
> 不要让自动化测试连接生产数据库。生产发布脚本会从正式备份创建临时副本，在副本上完成 schema、API、数据库审计和真实浏览器验收。

## 生产部署

仓库提供当前生产环境使用的容器化发布方案：

- `Dockerfile.production`：Node.js 应用镜像，并可固定安装 OpenClaw 版本。
- `compose.production.yaml`：使用 host network、只读根文件系统、能力裁剪和健康检查。
- `deploy/deploy-production.sh`：备份、构建、数据库副本迁移、自动化验收、切流与失败恢复。
- `deploy/cleanup-orphan-users.sh`：带整库备份、数量校验和事务保护的孤立账号清理脚本。

生产拓扑使用 Caddy 终止 HTTPS，将公网流量转发到宿主机回环地址上的应用容器。`/api/internal/*` 必须在反向代理层拒绝公网访问。

当前站点的完整发布、验证和回退步骤见 [deploy/README.zh-CN.md](deploy/README.zh-CN.md)。该脚本针对当前服务器目录布局编写，不应未经审查直接复制到其他主机。

## 安全设计

- 密码使用 Node.js `scrypt` 加盐哈希，恢复码仅保存哈希。
- 会话令牌仅保存 SHA-256 哈希；浏览器 Cookie 使用 `HttpOnly`、`SameSite=Lax`，HTTPS 下增加 `Secure`。
- 所有业务查询限定当前空间或当前用户；积分变更、兑换和 AI 确认使用数据库事务。
- 服务端统一设置 CSP、`X-Frame-Options`、`X-Content-Type-Options` 与 `Referrer-Policy`。
- CalDAV 应用专用密码使用 `AES-256-GCM` 加密后保存。
- 微信身份使用 HMAC 索引，不保存由模型提供的用户或空间标识。
- OpenClaw 内部接口要求独立令牌、回环来源，并应由反向代理阻断公网访问。
- AI 写操作只允许白名单动作，并要求用户在网页或微信流程中再次确认。
- 关键操作写入 `audit_logs`；数据库审计工具只读检查成员关系、孤立记录和过期会话。

本项目不收集支付卡信息，也不应在仓库、日志、截图或测试数据中保存真实密码、API Key、微信身份或未脱敏的个人数据。

## 项目结构

```text
Rainbow-Cats/
├─ web/                       # 当前原生网页客户端
│  ├─ index.html
│  ├─ app.js
│  └─ styles.css
├─ server/                    # 当前 Node.js + PostgreSQL 服务端
│  ├─ src/server.js           # HTTP 服务、API 与静态资源入口
│  ├─ schema.sql              # 当前数据库 schema 与增量升级
│  ├─ migrations/             # 独立迁移脚本
│  ├─ test/                   # API、UI 与网页回归测试
│  └─ tools/                  # 数据审计与 CloudBase 迁移工具
├─ openclaw-plugin/           # OpenClaw 微信接入插件
├─ deploy/                    # 生产发布、浏览器验收与运维脚本
├─ miniprogram/               # 历史微信小程序客户端
├─ cloudfunctions/            # 历史 CloudBase 云函数
├─ prototype/                 # 历史 HTML 视觉原型
├─ Pics/                      # 历史小程序说明图片
├─ compose.production.yaml
└─ Dockerfile.production
```

数据模型主要包括用户与会话、双人空间与成员、心愿、礼物与收藏、菜谱、日程与 CalDAV 连接、支出与预算、相册元数据、AI 提案、微信身份绑定、API 用量和审计日志。数据库定义以 [`server/schema.sql`](server/schema.sql) 为准。

## 历史小程序

`miniprogram/`、`cloudfunctions/` 和 `prototype/` 是 2026 年 Web 迁移前的历史实现，不参与当前网页运行和生产镜像构建。

如需维护或验证历史版本：

1. 使用微信开发者工具打开仓库根目录。
2. 检查 [`miniprogram/config.js`](miniprogram/config.js) 中的 `envId`，确认它指向预期 CloudBase 环境。
3. 在微信开发者工具中切换到同一云环境。
4. 云函数统一选择“上传并部署：云端安装依赖”。
5. TianAPI 和 OpenClaw 等密钥只配置在云函数环境变量中，不得写入客户端或提交到仓库。

历史集合、云函数和迁移边界见 [WEB_PLAN.md](WEB_PLAN.md) 与 [OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md)。删除任何历史页面、图片、依赖或云函数前，必须先完成引用审计、数据迁移演练，并在微信开发者工具中重新编译验证。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [docs/使用说明书.md](docs/使用说明书.md) | 面向普通用户的完整网页操作手册 |
| [USER_GUIDE.md](USER_GUIDE.md) | 面向使用者的功能、本地部署与常见问题说明 |
| [server/README.md](server/README.md) | 服务端环境变量、API 领域、迁移、审计与测试 |
| [deploy/README.zh-CN.md](deploy/README.zh-CN.md) | 当前生产服务器的发布、验收和回退手册 |
| [WEB_TEST_GUIDE.md](WEB_TEST_GUIDE.md) | 双人功能、桌面端和移动端的完整测试清单 |
| [OPENCLAW_WECHAT_GUIDE.md](OPENCLAW_WECHAT_GUIDE.md) | OpenClaw 微信助手的身份、安全和部署边界 |
| [openclaw-plugin/README.md](openclaw-plugin/README.md) | OpenClaw 插件构建、测试与配置 |
| [HTML_OPENCLAW_EXECUTION.md](HTML_OPENCLAW_EXECUTION.md) | Web 迁移、生产检查与 OpenClaw 执行记录 |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | Web 界面颜色、字体与交互设计规范 |
| [WEB_PLAN.md](WEB_PLAN.md) | 从小程序迁移到独立网页的设计与验收背景 |
| [DAILY_REPORT.md](DAILY_REPORT.md) | 项目阶段性开发与验证记录 |

## 开发约定

- 当前功能开发以 `web/` + `server/` 为主，不在历史小程序上重复实现新功能。
- 网页客户端不得直接读写 PostgreSQL，所有业务写入通过服务端 API。
- 修改数据库表、字段或服务端业务接口时，同步更新 `server/schema.sql` 与 `server/README.md`。
- 生产部署前必须完成备份、隔离数据库验证、浏览器验收和回退路径检查。
- 不提交密钥、真实个人身份、生产数据库副本或未脱敏的云端数据。

提交问题时，请附上复现步骤、预期结果、实际结果、浏览器/系统版本和必要的脱敏日志；安全问题请勿在公开 Issue 中附带真实凭据或个人数据。

## 项目状态

截至 2026-09-24：

- Web 主线、独立 PostgreSQL 后端和生产容器发布流程已投入使用。
- 生产健康检查可通过 `https://rainbow.251104.xyz/api/v1/health` 验证。
- TianAPI、CalDAV、OpenClaw 网页聊天和微信助手均为可选集成，需要部署者自行配置凭据。
- CloudBase 小程序代码仅作历史归档和迁移参考。

## 许可证

本项目使用 [MIT License](LICENSE)。
