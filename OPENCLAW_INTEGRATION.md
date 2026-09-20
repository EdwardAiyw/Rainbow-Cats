# 项目对接说明

更新时间：2026-09-06

这份文档保留微信小程序/CloudBase 的历史对接记录。当前正式主线为 HTML + Node.js + PostgreSQL；服务端 OpenClaw 接口、网页聊天代理和环境变量以 `server/README.md` 与 `HTML_OPENCLAW_EXECUTION.md` 为准。小程序订阅消息仅在仍维护历史小程序版本时才需要配置。

## 一、项目现状

这是一个微信云开发双人任务/心愿/礼物小程序，云环境配置在：

- `miniprogram/config.js`
- 当前环境 ID：`cloud1-2gc6ss1ca2b8db52`

数据变更统一通过云函数完成，客户端不直接写数据库。

最近已完成：

- iOS 输入框适配：昵称、邀请码、心愿、礼物和搜索输入已增加光标、文字颜色和键盘间距处理。
- 昵称内嵌编辑：首页积分卡片可以修改昵称。
- 用户删除入口：收藏页右上角进入“设置”，设置页可以删除当前用户资料。
- 用户删除范围：`deleteMembership` 会清理当前用户在当前空间中的 `Memberships`、`MissionList`、`MarketList` 和 `StorageList` 记录，并从 `Spaces.memberOpenIds` 移除当前用户；该操作不影响对方用户数据，且不可恢复。

## 二、微信订阅消息配置

### 需要准备的信息

在微信公众平台/小程序后台申请订阅消息模板，并记录模板 ID。当前代码预设两个字段：

- `thing6`：任务标题
- `thing9`：提醒内容

模板 ID 不能留空。不要把 AppSecret、云 API 密钥或其他敏感凭据写入项目。

### 需要填写的位置

同一个模板 ID 需要配置在三个位置：

1. `miniprogram/config.js`

   ```js
   notificationTemplateId: '微信后台提供的模板ID'
   ```

2. `cloudfunctions/information/notification.config.js`

   ```js
   templateId: '微信后台提供的模板ID'
   ```

3. `cloudfunctions/addElement/notification.config.js`

   创建心愿后的通知由 `addElement` 直接发送，因此该配置也必须同步。

如果模板字段不是 `thing6` 和 `thing9`，同步修改 `taskField` 和 `noteField`，字段名必须与微信后台模板一致。

### 相关代码

- 用户授权：`miniprogram/pages/MainPage/index.js` 的 `requestSubscribeMessage`
- 授权入口：首页“空间已连接”卡片中的“开启任务提醒”
- 通知发送：`cloudfunctions/addElement/index.js`（创建心愿主链路）和 `cloudfunctions/information/index.js`
- 通知配置：`cloudfunctions/information/notification.config.js` 和 `cloudfunctions/addElement/notification.config.js`

### 当前待完成事项

当前已经有授权入口和通知云函数。`addElement` 已补上“创建心愿 → 通知另一位成员”的容错链路：心愿先落库，通知发送失败不会阻断创建。模板 ID 配置后需要重新部署 `addElement` 和 `information` 并完成双账号验收。

## 当前故障记录：iPhone 心愿页云服务请求失败

2026-08-21 的 iPhone 截图显示：心愿列表仍有旧数据，但页面出现“网络或云服务连接失败”。这表示页面缓存渲染成功，但新的 `getCurrentSpace` 或 `listElements` 请求失败，不是输入框样式问题。

排查顺序：

1. 确认开发者工具当前云环境为 `cloud1-2gc6ss1ca2b8db52`。
2. 确认已部署 `getCurrentSpace` 和 `listElements`，并查看云函数调用日志。
3. 确认数据库存在 `Memberships`、`MissionList` 集合，并检查权限。
4. 如果当前账号刚执行过删除用户，确认它已重新创建或加入双人空间。
5. 清除开发者工具缓存后重新编译，再用 iPhone 真机重试。
6. 若仍失败，记录调试控制台中第一条红色错误；当前客户端会把多种错误归并显示为网络/云服务失败，不能只凭 Toast 判断根因。

### 部署顺序

在微信开发者工具中分别上传并部署，选择“云端安装依赖”：

1. `information`
2. `addElement`（补完通知调用后重新部署）
3. 其他本次改动过的云函数：`updateDisplayName`、`deleteMembership`

## 三、OpenClaw 对接待确认

当前工作区未检测到 `openclaw` 命令，但项目已提供独立服务器适配入口；OpenClaw 客户端工具仍需单独配置。

下一次继续前需要确认 OpenClaw 的目标：

- 将 OpenClaw 接入这个小程序，用于接收任务/通知？
- 用 OpenClaw 自动管理云函数部署和项目流程？
- 在本机安装 OpenClaw？

需要准备 OpenClaw 的官方地址、安装方式、运行环境和期望调用接口。若需要访问微信云开发或第三方服务，应使用当前机器的认证存储，不要把令牌写入仓库。

### 业务 API 第一批

项目新增 `cloudfunctions/openclawApi` 作为 OpenClaw 的受保护业务入口。请求必须包含服务端环境变量对应的 `token` 和已登记的 `actorId`，不接受 OpenClaw 直接传入任意 `openId`。当前动作如下：

| action | 必填参数 | 作用 |
| --- | --- | --- |
| `listMissions` | 无 | 查询当前绑定用户所在空间的心愿 |
| `listMarket` | 无 | 查询当前空间可见礼物 |
| `listStorage` | 无 | 查询当前用户已兑换礼物 |
| `createMission` | `title`, `credit`；可选 `desc` | 创建心愿 |
| `completeMission` | `id` | 完成对方发布的心愿并增加发布者积分 |
| `purchaseGift` | `id` | 扣除当前用户积分并写入收藏 |

云函数环境变量使用当前机器/云端的认证存储配置：`OPENCLAW_API_TOKEN` 保存共享服务令牌，`OPENCLAW_ACTOR_MAP` 保存 `actorId` 到微信 `openId` 的映射。两者都不能提交到仓库。完成部署后，再在远程 OpenClaw 中配置 MCP 工具，将工具参数转换为上述 action 请求；完成任务和兑换礼物前必须由对话层二次确认。

独立服务器同样提供 `POST /api/v1/openclaw`，请求体包含 `token`、`actorId`、`action`，并将 `actorId` 映射到 PostgreSQL `users.legacy_open_id`。当前支持查询空间、心愿、礼物、收藏、菜谱，以及创建/完成心愿、添加菜谱、兑换礼物、使用收藏和修改昵称。网页聊天通过登录态 `POST /api/v1/openclaw/chat` 代理到服务端配置的 OpenClaw Gateway，浏览器不接触 Gateway token。

## 四、下一次继续清单

- [ ] 提供微信订阅消息模板 ID。
- [ ] 确认模板字段是否为 `thing6`、`thing9`。
- [ ] 填写客户端和 `information` 云函数配置。
- [ ] 排查 iPhone 心愿页的 `getCurrentSpace` / `listElements` 调用失败。
- [x] 补上 `addElement` 创建心愿后的通知调用。
- [ ] 部署 `information` 和 `addElement`。
- [ ] 用两个微信账号分别授权订阅并创建心愿。
- [ ] 验证另一位成员收到任务提醒。
- [ ] 确认通知失败时心愿仍能正常创建。
- [x] 提供服务器端 OpenClaw API 的对接入口和动作说明。
- [ ] 配置真实 OpenClaw token、actor 映射并完成本地联调。
- [ ] 在小米和 iPhone 真机分别验收输入、订阅授权和用户删除。

## 五、验收标准

- 模板 ID 配置后，首页可以正常请求订阅授权。
- 创建者发布心愿后，另一位成员收到订阅消息。
- 未授权、模板未配置或通知发送失败时，心愿创建仍然成功。
- 删除用户前有二次确认，删除后当前用户回到未加入空间状态。
- 删除后对方仍可以继续使用自己的成员资料。
- iOS 输入框有光标，输入文字可见，已有昵称可以回显和修改。
