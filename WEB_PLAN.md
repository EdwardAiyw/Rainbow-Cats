# 网页版改造方案：我们的日常空间（Rainbow-Cats Web）

> 版本：v1.0　日期：2026-08-27
> 目标：把「我们的日常空间」从微信小程序改造成**网页版**，并**与 OpenClaw（小一）深度连接**。
> 背景：小程序限制多（审核、web-view、分享、订阅消息等），网页版更自由、可全平台访问。
>
> 状态（2026-09-06）：本文件保留为迁移决策和验收边界的历史方案。正式实现已确定为 `web/` + `server/` 的 Node.js/PostgreSQL 自建后端；不再采用本文推荐的“CloudBase 路线 A”作为主线。当前运行、数据库审计与 OpenClaw 配置以根目录 README、`server/README.md` 和 `HTML_OPENCLAW_EXECUTION.md` 为准。

---

## 一、项目现状梳理

### 1.1 技术栈（现状）

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 前端 | 微信小程序（WXML/WXSS/JS） | 13 个页面、5 个 Tab：空间/心愿/礼物/菜谱/收藏 |
| 后端 | 微信云开发（CloudBase）云函数 | 25 个云函数，Node.js + wx-server-sdk |
| 数据库 | CloudBase 云数据库 | 6 个集合（见下） |
| 原型 | `prototype/` 纯 HTML/CSS/JS | 脱敏 mock 数据，已覆盖全部页面 |
| AI 入口 | `cloudfunctions/openclawApi` | 已实现 6 个受保护动作 |

### 1.2 数据模型（6 个集合）

| 集合 | 用途 | 关键字段 |
| --- | --- | --- |
| `Spaces` | 双人空间 | 邀请码、成员 openId 列表 |
| `Memberships` | 成员资料 | openId、昵称、积分 credit、空间 ID |
| `MissionList` | 心愿/任务 | 标题、积分、available、star、完成人 |
| `MarketList` | 礼物商城 | 标题、积分、available、购买人 |
| `StorageList` | 已兑换收藏 | 来源礼物、可用状态、使用记录 |
| `RecipeList` | 双人菜谱库 | 菜谱条目（+`ApiUsage` 记录 TianAPI 调用量） |

### 1.3 核心业务规则

- 双人空间：创建者生成邀请码，另一人凭邀请码加入，空间内两人共享数据。
- 心愿：发布心愿（设置积分）→ 对方完成 → **发布者**获得积分。
- 礼物：上架礼物（标价积分）→ 对方兑换 → 进入收藏（StorageList）→ 可使用。
- 菜谱：双人维护菜谱库；TianAPI 在线搜索，每天限 95 次。
- 积分上限：`maxCredit = 500`。
- 所有数据变更走云函数事务，客户端不直写数据库。

### 1.4 已存在的 OpenClaw 入口（openclawApi）

| action | 作用 | 鉴权 |
| --- | --- | --- |
| `listMissions` / `listMarket` / `listStorage` | 查心愿/礼物/收藏 | `token`（环境变量 `OPENCLAW_API_TOKEN`）+ `actorId`（映射 `OPENCLAW_ACTOR_MAP` → 微信 openId） |
| `createMission` | 创建心愿 | 同上 + 事务校验 |
| `completeMission` / `purchaseGift` | 完成任务 / 兑换礼物 | 同上 + 事务校验 |

---

## 二、方案选型

### 2.1 总体思路

```
[手机浏览器 / 电脑浏览器]  ←→  [网页前端（响应式）]  ←→  [API 服务层]  ←→  [云开发数据库]
                                            ↑
                                        [OpenClaw 小一]  （同一套 API，双向交互）
```

- **前端**：基于现有 `prototype/` 升级为正式响应式网页（原生 HTML/CSS/JS 或轻量 Vue3，见 4.2）。
- **后端**：两套可选路线（见 2.2），推荐 **路线 A：保留云开发**，改动最小、数据零迁移。
- **AI 连接**：OpenClaw 复用/扩展 `openclawApi`，作为"空间管家"。

### 2.2 后端路线对比

| 项 | 路线 A：保留云开发（推荐先做） | 路线 B：自建后端（彻底独立） |
| --- | --- | --- |
| API 暴露 | 云函数加 HTTP 触发 / 云开发 HTTP 访问服务 | 自建 Node.js 服务（Express/Fastify） |
| 数据库 | 不动，零迁移 | 需从云开发导出导入（JSON） |
| 身份 | 需处理"网页无 openId"（见 4.3） | 自建用户表，完全自主 |
| 成本 | 低（云开发按量付费） | 服务器 + 数据库运维 |
| 上线速度 | 快（1~2 天可跑通） | 慢（1~2 周） |
| 适合 | 快速脱离小程序限制、保留数据 | 长期完全去微信化 |

> **结论**：先用路线 A 把网页版跑起来（保留现有数据和云函数逻辑），
> 若后续需要完全自管再按路线 B 迁移（文档 §9 附迁移思路）。

---

## 三、总体架构图

```
┌─────────────────────────────── 用户侧 ───────────────────────────────┐
│  手机浏览器 / 电脑浏览器（无需安装、无需审核）                          │
│  https://你的域名  →  静态页面（登录 → 空间 → 心愿/礼物/菜谱/收藏）    │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ HTTPS / JSON
┌──────────────────────────────────▼───────────────────────────────────┐
│  API 服务层（云开发云函数 HTTP 触发，或自建服务）                       │
│  /api/login  /api/space  /api/mission  /api/market  /api/recipe       │
│  /api/storage  /api/notify                                            │
│  鉴权：用户 token（签发制） + 空间/成员校验 + 事务                      │
└──────────────┬───────────────────────────────┬───────────────────────┘
               │                                │
┌──────────────▼──────────────┐   ┌─────────────▼──────────────────────┐
│  CloudBase 云数据库          │   │  OpenClaw（小一）                  │
│  Spaces/Memberships/         │   │  通过 openclawApi 调用同一套业务   │
│  MissionList/MarketList/     │   │  场景：查进度/发心愿/提醒/陪聊     │
│  StorageList/RecipeList      │   │  通知：微信推送（已有通道）         │
└─────────────────────────────┘   └────────────────────────────────────┘
```

---

## 四、前端改造方案

### 4.1 页面映射（小程序 → 网页）

| 小程序页面 | 网页页面 | 说明 |
| --- | --- | --- |
| MainPage（空间首页） | `index.html` / `#/home` | 积分卡片、邀请码、双人状态 |
| Mission / MissionAdd / MissionDetail | `#/missions` + 弹层/详情页 | 心愿列表、新建、完成 |
| Market / MarketAdd / MarketDetail | `#/market` + 详情 | 礼物商城、上架、兑换 |
| Recipe / RecipeAdd / RecipeDetail | `#/recipes` | 菜谱库 + TianAPI 搜索 + 随机一道菜 |
| Account / ItemDetail | `#/storage` | 收藏、使用记录 |
| Settings | `#/settings` | 昵称修改、退出空间、删除账号 |

> `prototype/pages/` 已有全部页面的 HTML 视觉稿，直接作为网页版基础。

### 4.2 技术选型（前端）

- **推荐**：原生 HTML/CSS/JS（单页应用，Hash 路由）+ fetch 调 API。
  优点：零构建、零依赖、静态托管即可、手机打开快。
- 备选：Vue3 + Vite（若后续交互复杂、需要组件化再升级，可渐进替换）。
- 样式：复用 `prototype/styles.css` 的暖色视觉（#ffd84d / #ff3f78 / #fff8ee），做移动端优先的响应式（≤480px 单列，≥768px 双栏）。

### 4.3 身份与登录（关键改造点）

小程序用微信 openId 识别用户，网页没有。方案：

1. **登录**：昵称 + 邀请码（创建空间或加入空间）。
   - 创建空间：输入昵称 → 创建 → 得到邀请码。
   - 加入空间：输入昵称 + 邀请码 → 加入。
2. **会话**：服务端签发 `userToken`（随机串，存 `Sessions` 集合或 `Memberships.token`），前端存 `localStorage`，每次请求带 `Authorization: Bearer <token>`。
3. **成员识别**：云函数通过 token 反查 Memberships，替代 `_openid`；数据结构兼容现有集合（可给 Memberships 增加 `userId` 字段，openId 字段保留为空或微信用户继续用）。

### 4.4 通知替代（网页版没有订阅消息）

| 场景 | 方案 |
| --- | --- |
| 心愿被完成 / 收到新礼物 | OpenClaw 通过微信推送给艾博士（已有推送通道），或邮件 |
| 网页内提醒 | 浏览器 Notification API（需授权，可做可不做） |
| 每日总结 | 小一每天早上推送空间日报（积分/心愿进度） |

---

## 五、API 设计（路线 A：云函数 HTTP 触发）

项目当前已提供独立 Node.js 服务器入口 `/api/v1/openclaw`；CloudBase 侧仍保留 `openclawApi`。两者均使用受保护的动作接口，后续应继续共用动作约定：

| 方法 | 路径 / action | 说明 |
| --- | --- | --- |
| POST | `login` | 昵称+邀请码 → 签发 token |
| POST | `createSpace` | 创建空间，返回邀请码 |
| GET | `getSpace` | 空间信息、双方昵称、积分 |
| GET/POST | `listMissions` / `createMission` | 心愿列表 / 新建 |
| POST | `completeMission` | 完成对方心愿（积分事务） |
| GET/POST | `listMarket` / `createMarket` | 礼物列表 / 上架 |
| POST | `purchaseGift` / `useStorageItem` | 兑换 / 使用收藏 |
| GET/POST | `listRecipes` / `addRecipe` / `searchRecipe` | 菜谱库 / 新增 / TianAPI 搜索 |
| POST | `updateDisplayName` / `deleteMembership` | 昵称 / 退出删除 |

鉴权：请求头 `Authorization: Bearer <userToken>`；云函数内校验 token → 空间成员 → 事务执行（复用现有逻辑）。

> 部署细节：云函数开启 HTTP 触发（腾讯云 API 网关 / 云开发 HTTP 访问服务），配置 CORS 允许你的网页域名。`webApi` 与 `openclawApi` 共用同一套业务模块，避免逻辑分叉。

---

## 六、与 OpenClaw（小一）的连接

### 6.1 现状

`cloudfunctions/openclawApi` 已实现 6 个动作，鉴权用 `OPENCLAW_API_TOKEN` + `OPENCLAW_ACTOR_MAP`（actorId → 微信 openId）。

### 6.2 扩展计划

1. **补齐动作**：`getSpace`（查积分）、`useStorageItem`（使用收藏）、`listRecipes`/`addRecipe`、`updateDisplayName`。
2. **OpenClaw 侧接入**：在工作区配置 HTTP 工具（或 MCP），把 `openclawApi` 暴露为小一可调用的工具；完成任务/兑换礼物等写操作前，小一必须向用户二次确认。
3. **双向交互场景**：
   - "帮我看下我们俩现在各多少分" → `getSpace`
   - "帮我记个心愿：周末去看电影，50 分" → `createMission`
   - "TA 完成心愿了，告诉我一声" → 云函数事件 → 小一推微信
   - "晚上吃什么" → `searchRecipe`（随机一道菜）
   - 每日日报：小一早上自动汇报空间动态。
4. **网页聊天入口（可选）**：网页右下角加"问小一"浮窗，通过 OpenClaw Gateway API 转发到微信会话，用户在不同端都能找我。

### 6.3 安全约定

- `OPENCLAW_API_TOKEN`、`OPENCLAW_ACTOR_MAP` 只放云函数环境变量，不进仓库、不进前端。
- 网页端 token 与 OpenClaw 的 token 分离：网页用户 token 只能操作自己所在空间；OpenClaw token 受 actorMap 限制到指定成员。
- 写操作（完成心愿、兑换、删除）一律二次确认 + 事务。

---

## 七、实施步骤（分阶段）

### Phase 1：静态网页跑起来（0.5~1 天）
- [ ] 以 `prototype/` 为基础，整理为正式页面结构（index + 各页面 + 路由）。
- [ ] 本地浏览器打开验证布局、交互（mock 数据阶段）。
- [ ] 部署静态页到可访问地址（云开发静态托管 / 服务器 nginx / GitHub Pages 均可）。

### Phase 2：接入真实后端（1~2 天）
- [ ] 新增 `webApi` 云函数（登录 + 空间 + 心愿，先跑通主链路）。
- [ ] 云函数开 HTTP 触发 + CORS。
- [ ] 网页登录页对接：创建/加入空间、token 存取。
- [ ] 心愿列表/新建/完成 真实数据联调。

### Phase 3：全功能补齐（1~2 天）
- [ ] 礼物（上架/兑换/收藏/使用）。
- [ ] 菜谱（库 + TianAPI 搜索 + 随机一道菜，注意 95 次/天限额）。
- [ ] 设置（改昵称、退出空间、删除账号，删除要二次确认）。

### Phase 4：OpenClaw 对接（1 天）
- [ ] 扩展 `openclawApi` 动作（6.2 列表）。
- [ ] 小一工作区配置调用工具，实测"查积分/记心愿/完成/兑换"全流程。
- [ ] 完成/兑换前二次确认机制。

### Phase 5：通知与打磨（1 天）
- [ ] 空间动态 → 小一微信推送（复用现有推送通道）。
- [ ] 每日日报（可选）。
- [ ] 真机（手机浏览器）验收：iPhone + Android，键盘、布局、刷新。

---

## 八、验收标准

- [ ] 手机浏览器直接打开网址即可使用，无需下载、无需审核。
- [ ] 双人创建/加入空间、积分流转与小程序版一致。
- [ ] 心愿、礼物、菜谱、收藏全链路可用，数据与云开发数据库一致。
- [ ] 小一能通过 openclawApi 查空间、建心愿、完成任务、兑换礼物，写操作有二次确认。
- [ ] 网页版 token 无法越权操作他人/他空间数据。
- [ ] 通知链路可用（微信推送替代订阅消息）。

---

## 九、附：路线 B 自建后端迁移思路（备用）

1. 云开发控制台导出 6 个集合 JSON。
2. 服务器建 Node.js 服务（Express + SQLite/MySQL），建同名表。
3. 云函数业务逻辑平移为普通 Node 模块（wx-server-sdk → 自研 db 层）。
4. 前端 API 地址切换；删除小程序相关代码（wx.cloud → fetch）。
5. 通知改邮件/微信推送（小一通道）。
6. 逐步下线云开发（保留只读备份一段时间）。

> 何时选 B：云开发 HTTP 配额不够用、需要自定义域名 HTTPS、需要更多第三方集成、或想完全掌控数据时。

---

## 十、待确认事项

1. 网页版访问域名/部署位置（云开发静态托管？还是服务器？）。
2. 是否保留小程序版并行运行（建议保留，双端同库）。
3. 通知方式偏好：微信推送为主？还是加邮件？
4. 是否要"网页问小一"聊天浮窗（OpenClaw Gateway 对接）。

---

*文档由 OpenClaw（小一）根据项目现状生成，实施时可随时找我联调。*
