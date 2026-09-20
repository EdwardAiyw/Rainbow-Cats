# 我们的日常空间（Rainbow-Cats Web）

这是一个独立网页双人生活空间：共同创建心愿、完成任务、兑换礼物、记录菜谱、共享日程、管理账本和保存私密相册元数据。正式交付目标是 `web/` + `server/`，不再以微信小程序作为产品入口。

完整的用户操作、本地部署和常见问题说明见 [`USER_GUIDE.md`](USER_GUIDE.md)。

## 当前网页主线

```powershell
cd server
npm install
$env:DATABASE_URL='postgres://postgres:密码@127.0.0.1:5432/rainbow_cats'
& 'D:\Program Files\PostgreSQL\18\bin\psql.exe' -v ON_ERROR_STOP=1 $env:DATABASE_URL -f schema.sql
npm start
```

浏览器打开 `http://localhost:3000`。账号使用用户名、密码和一次性恢复码；创建或加入空间后，所有数据变更都通过服务端 API 完成。生产部署必须配置 HTTPS、`SESSION_SECRET`、`WEB_ORIGIN`、数据库备份与限流。

网页 API、环境变量和迁移说明见 [`server/README.md`](server/README.md)。

`rainbow.251104.xyz` 的 Docker 生产发布、正式数据库副本联调、Playwright 浏览器验收和一键回退说明见 [`deploy/README.zh-CN.md`](deploy/README.zh-CN.md)。

`miniprogram/`、`cloudfunctions/` 和 `prototype/` 暂时保留为历史实现和迁移参考，不作为网页运行时依赖；删除前必须完成引用审计和数据迁移演练。

## 历史小程序说明

## 第一次运行

1. 使用微信开发者工具打开项目根目录。
2. 打开 `miniprogram/config.js`，确认 `envId` 是云开发环境 ID：

   ```js
   envId: 'cloud1-2gc6ss1ca2b8db52'
   ```

   这里填写的是“云开发 → 环境设置”中的环境 ID，不是小程序 AppID。
3. 点击开发者工具顶部“云开发”，切换到同一个环境。
4. 在云开发数据库中创建以下集合（权限建议先使用“仅管理员可读写”，由云函数访问）：
   - `Spaces`
   - `Memberships`
   - `MissionList`
   - `MarketList`
   - `StorageList`
   - `RecipeList`
   - `ApiUsage`
5. 将 `cloudfunctions` 下这些文件夹逐个右键，选择“上传并部署：云端安装依赖”：
   `createSpace`、`joinSpace`、`getCurrentSpace`、`addElement`、`listElements`、`getElementById`、`completeMission`、`purchaseItem`、`useStorageItem`、`editStar`、`deleteElement`、`updateDisplayName`、`deleteMembership`、`information`、`recipeApi`。
6. 重新编译小程序，在“空间”页输入昵称并创建空间。

## 两人使用流程

创建者：空间 → 输入昵称 → 创建空间 → 复制邀请码。

另一位用户：空间 → 输入昵称和邀请码 → 加入空间。

之后可以按这个顺序测试：

1. “心愿” → `+` → 创建一个心愿。
2. 另一位用户在心愿列表点击“完成”，创建者获得对应积分。
3. “礼物” → `+` → 上架一份礼物并设置积分。
4. 对方使用积分点击“兑换”，礼物会进入“收藏”。
5. “收藏”中点击“使用”，即可记录礼物已使用。
6. “菜谱”中可以维护双人菜谱库，也可以搜索 TianAPI 官方菜谱并点击“随机一道菜”解决不知道吃什么的问题。

## 常见问题

- 页面提示“请先配置云环境”：检查 `config.js` 的 `envId` 是否为空，并重新编译。
- 创建空间没有反应：确认 `createSpace` 已部署，且数据库包含 `Spaces`、`Memberships`。
- 列表加载失败：确认对应云函数已部署，并检查云开发控制台的函数日志。
- 兑换失败：确认双方在同一个空间，且购买者积分不少于礼物价格。
- 菜谱保存或加载失败：确认已创建 `RecipeList`、`ApiUsage` 集合，并重新部署 `addElement`、`listElements`、`getElementById`、`editStar`、`deleteElement`、`deleteMembership`、`recipeApi`。

`maxCredit` 默认为 500；`notificationTemplateId` 可选，用于任务订阅提醒。

订阅提醒：从微信后台取得模板 ID 后，同时填写 `miniprogram/config.js`、`cloudfunctions/information/notification.config.js` 和 `cloudfunctions/addElement/notification.config.js`，并重新部署 `information`、`addElement`。创建心愿会先保存数据，通知失败不会阻断保存。

昵称修改：部署 `cloudfunctions/updateDisplayName` 后，首页“我们的积分”卡片右上角的“修改昵称”可以更新当前用户昵称；更新通过云函数写入 `Memberships.displayName`。

成员资料删除：部署 `cloudfunctions/deleteMembership` 后，可从设置页删除当前用户的成员资料并退出当前空间；相关数据清理规则见下方“用户删除”说明。

用户删除：删除入口位于“收藏”页面右上角的“设置”。部署 `deleteMembership` 后，删除会同时清理当前用户的 `Memberships`、`MissionList`、`MarketList`、`StorageList` 和 `RecipeList` 中属于当前空间的数据，并从 `Spaces.memberOpenIds` 移除当前用户；该操作不可恢复，相关历史记录不会保留。

TianAPI 菜谱：`recipeApi` 云函数会读取云函数环境变量 `TIANAPI_KEY`。不要把 key 写入小程序前端或提交到仓库；在微信云开发控制台为 `recipeApi` 配置环境变量后，重新部署该云函数。为避免免费额度被刷完，`recipeApi` 会通过 `ApiUsage` 集合按天记录 TianAPI 菜谱请求次数，当天达到 95 次后停止请求官方接口，并提示“那就吃我吧”。
继续配置和 OpenClaw 对接请阅读 [OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md) 与 [OPENCLAW_WECHAT_GUIDE.md](OPENCLAW_WECHAT_GUIDE.md)。

OpenClaw 业务入口：`cloudfunctions/openclawApi` 是受保护的服务端调用入口，当前支持 `listMissions`、`listMarket`、`listStorage`、`createMission`、`completeMission` 和 `purchaseGift`。部署后必须在云函数环境变量中配置 `OPENCLAW_API_TOKEN` 与 JSON 格式的 `OPENCLAW_ACTOR_MAP`（例如 `{"main":"微信用户 openId"}`）；不要将这些值写入仓库。所有操作仍在云函数中校验空间成员身份并执行事务。

网页版菜谱兜底：网页版服务器会先搜索 TianAPI；精确搜索无结果时，会继续检索相关关键词。若远端服务器与 OpenClaw Gateway 部署在同一台机器，并设置 `OPENCLAW_RECIPE_ENABLED=true`，仍无结果时由 OpenClaw 生成“菜名、简介、食材、调料、步骤、小贴士”格式的参考做法。AI 结果会明确标记为“AI 生成”，不作为官方菜谱展示；Gateway 仅监听本机回环地址，不对公网开放。

## 网页版后端（当前主线）

`web/` 是正式原生 HTML/CSS/JS 客户端，`server/` 是独立 Node.js + PostgreSQL 后端。网页版提供登录、双人空间、心愿、礼物、收藏、自建/官方菜谱、设置和账号删除；OpenClaw 同时提供微信对话动作接口与可选网页聊天代理。生产环境需执行 `server/schema.sql`，并通过环境变量配置数据库、CORS、TianAPI 和 OpenClaw 凭据。小程序代码保留为历史归档，正式开发和部署以 HTML + 独立服务器为准；CloudBase 数据迁移必须在备份、演练和停写窗口完成后执行。

详细迁移边界和验收标准见 [`WEB_PLAN.md`](WEB_PLAN.md)。

## HTML 原型与小程序页面（历史）

`prototype/` 保存浏览器端 HTML 视觉原型，使用脱敏 mock 数据，仅用于确认布局、文案和交互。原型定稿后，页面结构转换为 WXML，样式转换为 WXSS，交互转换为小程序 JavaScript；主业务页面不使用 `web-view`，仍通过 `miniprogram/utils/cloud.js` 调用云函数。打开 `prototype/index.html` 即可查看首页原型，其他页面位于 `prototype/pages/`。
