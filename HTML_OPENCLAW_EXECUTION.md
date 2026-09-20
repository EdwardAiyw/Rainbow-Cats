# HTML 全面迁移与 OpenClaw 执行清单

更新时间：2026-09-20

## 已直接完成

- HTML + Node.js + PostgreSQL 已作为项目主线。
- 网页端已加入“问小一”入口。
- 服务端已新增 `GET /api/v1/openclaw/status` 和 `POST /api/v1/openclaw/chat`；HTTP Gateway 未配置时自动回退到本机 CLI Gateway。
- OpenClaw 业务动作已扩展：`listRecipes`、`addRecipe`、`useStorageItem`、`updateDisplayName`。
- 已新增 `DELETE /api/v1/me`，包含空间所有者转移和资料清理。
- 已更新 README、OpenClaw 对接说明和项目日报。
- `openclaw` CLI 已安装，版本为 `2026.7.1-2`。

## 当前生产服务器检查结果

| 项目 | 结果 |
| --- | --- |
| OpenClaw CLI | 已安装，版本 `2026.7.1-2` |
| CLI Gateway 推理 | 已通过容器内 `openclaw infer model run --gateway` 实测 |
| `OPENCLAW_API_TOKEN` | 未配置 |
| `OPENCLAW_ACTOR_MAP` | 未配置 |
| `OPENCLAW_CHAT_URL` / `OPENCLAW_GATEWAY_TOKEN` | 未配置；当前不再阻塞网页聊天 |
| `OPENCLAW_RECIPE_ENABLED` | 已启用，因此默认同时启用 CLI 网页聊天 |
| PostgreSQL 与网页服务 | Docker 容器健康，数据库联调与公网健康检查已通过 |

## 可选的敏感配置

不要把真实值写入仓库或聊天记录。请在部署服务器的安全环境变量中填写：

```powershell
$env:OPENCLAW_API_TOKEN = '<生成的 Rainbow-Cats 服务令牌>'
$env:OPENCLAW_ACTOR_MAP = '{"main":"<对应微信用户的 legacy_open_id>"}'
$env:OPENCLAW_GATEWAY_TOKEN = '<仅在使用独立 HTTP Gateway 时配置>'
$env:OPENCLAW_CHAT_URL = 'http://127.0.0.1:<端口>/<实际聊天 HTTP 入口>'
$env:DATABASE_URL = 'postgres://<生产应用账户>:<密码>@<主机>:5432/rainbow_cats'
$env:TIANAPI_KEY = '<TianAPI key（可选）>'
```

网页聊天采用当前本机 CLI Gateway 时，不需要填写 `OPENCLAW_CHAT_URL` 或 `OPENCLAW_GATEWAY_TOKEN`。`OPENCLAW_API_TOKEN` 用于历史 CloudBase 接口；若以后启用独立 HTTP Gateway，其 Token 必须与其他服务令牌分开。

## OpenClaw 网页聊天运行方式

生产 `.env` 中已有 `OPENCLAW_RECIPE_ENABLED=true` 时，`OPENCLAW_CHAT_CLI_ENABLED` 留空即可继承启用状态。也可以显式配置：

```dotenv
OPENCLAW_CHAT_CLI_ENABLED=true
OPENCLAW_CHAT_MODEL=deepseek/deepseek-v4-flash
OPENCLAW_CHAT_DAILY_LIMIT=100
```

应用容器内执行的是一次性 `openclaw infer model run --gateway`，不启动公网监听，也不授予模型业务工具。模型返回的写操作只会形成待确认提案。若以后切换独立 HTTP Gateway，仍必须保持 loopback-only（`127.0.0.1`），不得直接暴露公网。

## 数据迁移执行步骤

1. 从 CloudBase 控制台导出并备份以下集合：`Spaces`、`Memberships`、`MissionList`、`MarketList`、`StorageList`、`RecipeList`。
2. 对导出文件脱敏，不提交真实 openId、令牌或个人数据。
3. 先执行 dry-run：

```powershell
$env:DATABASE_URL = 'postgres://<测试账户>:<密码>@127.0.0.1:5432/rainbow_cats'
cd server
npm run migrate:cloudbase -- 'D:\path\to\脱敏导出.json'
```

4. dry-run 无错误后，在测试库执行 `--apply`，再运行：

```powershell
npm run test:api
```

5. 正式环境必须先备份 PostgreSQL、安排 CloudBase 停写窗口，再执行导入和域名切换。

当前没有执行正式迁移：本机测试库可通过私有加载脚本连接且已完成审计/接口测试，但工作区仍未发现 CloudBase 导出文件，也未执行生产导入。

## 微信 OAuth 与真机验收

- 微信 OAuth 不能凭本地代码自动完成，需要公众号/开放平台资质、AppID、回调域名和合法 HTTPS 域名。
- 在 OAuth 资质准备前，网页继续使用“昵称 + 邀请码 + 会话 Token”登录。
- 真机验收需要实际 iPhone Safari 和 Android Chrome 设备，无法由当前服务器自动代替。

验收顺序：

1. 两个账号创建/加入同一空间。
2. 心愿、积分、礼物、收藏、菜谱全流程。
3. 微信 OpenClaw 查询与写操作确认。
4. 网页“问小一”聊天。
5. iPhone Safari、Android Chrome、桌面 Chrome/Edge。

## 当前阻塞项

- 微信渠道身份映射仍需真实微信账号完成绑定；它不影响当前网页 OpenClaw 聊天。
- 没有 CloudBase 导出文件和生产数据库连接，不能执行正式迁移。
- OAuth 资质和真机不在本机环境中。

这些项目不是代码缺口，而是必须由真实账号、云端数据或设备提供的外部条件。
