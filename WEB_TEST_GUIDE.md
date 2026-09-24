# Rainbow-Cats 网页版测试与记录文档

> 测试主线：`web/` + `server/`
>
> 测试日期：2026-09-24
>
> 测试人员：Codex（自动化回归）/ 用户（手工验收继续）
>
> 测试环境：Windows，隔离数据库 `rainbow_cats_manual`
>
> 浏览器：Microsoft Edge 153.0.4234.32（Headless）

## 1. 测试目标

本次测试覆盖网页版的：

- 登录、创建空间、加入空间、退出登录和会话恢复
- 双人空间成员同步与权限边界
- 两个独立浏览器会话中的任务、礼物、收藏与菜谱同步
- 心愿、积分、礼物、收藏和菜谱
- 日程、账本、相册和设置
- AI 助手未配置分支
- 桌面端、移动端模拟布局和刷新行为
- 测试数据清理与数据库完整性

真实 iPhone Safari、Android Chrome、TianAPI 和 OpenClaw 联调需要额外的设备或凭据，本文件不会把未验证项标记为通过。

## 2. 测试结果标记

每个项目完成后填写：

- `[x]` 通过
- `[ ]` 未执行
- `[!]` 失败，需要记录问题
- `N/A` 当前环境不适用

问题统一记录在第 18 节。

## 3. 环境准备

### 3.1 基础条件

- [x] Node.js 18+ 已安装
- [x] PostgreSQL 已安装并运行
- [x] Edge 或 Chrome 已安装
- [x] 当前目录为 `D:\program\Rainbow-Cats`
- [x] 已确认不会使用正式生产数据库测试

PowerShell 检查命令：

```powershell
node --version
Get-Service *postgres* | Select-Object Name,Status
```

记录：

```text
Node 版本：v24.19.0
PostgreSQL 服务状态：
Name               Status
----               ------
postgresql-x64-18 Running
浏览器及版本：Microsoft Edge 153.0.4234.32
```

### 3.2 加载本机测试数据库凭据

```powershell
cd D:\program\Rainbow-Cats
. C:\Users\1\.rainbow-cats-load-db.ps1
```

```
PS C:\Users\1> cd D:\program\Rainbow-Cats
PS D:\program\Rainbow-Cats> . C:\Users\1\.rainbow-cats-load-db.ps1
Rainbow-Cats DATABASE_URL loaded for this PowerShell session.
```

确认命令执行后没有报错。不要把密码、TianAPI key 或 OpenClaw token 写入本文档。

### 3.3 创建隔离测试数据库

以下数据库仅用于本轮手工测试：`rainbow_cats_manual`。

```powershell
$env:DATABASE_URL = $env:DATABASE_URL -replace '/rainbow_cats$','/rainbow_cats_manual'
& 'D:\Program Files\PostgreSQL\18\bin\psql.exe' `
  ($env:DATABASE_URL -replace '/rainbow_cats_manual$','/postgres') `
  -c "CREATE DATABASE rainbow_cats_manual"
```

```
CREATE DATABASE
```

如果提示数据库已经存在，可以继续；如果出现其他错误，记录到第 16 节。

初始化当前版本 schema：

```powershell
& 'D:\Program Files\PostgreSQL\18\bin\psql.exe' `
  -v ON_ERROR_STOP=1 `
  $env:DATABASE_URL `
  -f D:\program\Rainbow-Cats\server\schema.sql
```

检查结果：

```text
数据库创建：通过，使用 `rainbow_cats_manual`
首次 schema 初始化：失败；Windows psql 客户端使用 GBK 读取 UTF-8 中文默认值，导致 albums、expenses、calendar_events 未创建
修复：在 `server/schema.sql` 顶部加入 `\encoding UTF8`
复测命令：加入 `-v ON_ERROR_STOP=1`，确保任一 SQL 失败时立即停止
复测结果：通过；全部表和索引创建成功，无编码错误
```

## 4. 启动测试服务

在当前 PowerShell 窗口设置测试环境：

```powershell
$env:PORT = '3002'
$env:WEB_ORIGIN = 'http://127.0.0.1:3002'
$env:SESSION_SECRET = 'manual-test-session-secret-change-me'
$env:TIANAPI_KEY = ''
$env:OPENCLAW_CHAT_URL = ''
$env:OPENCLAW_GATEWAY_TOKEN = ''
```

启动服务：

```powershell
cd D:\program\Rainbow-Cats\server
npm start
```

看到以下内容表示服务启动：

```text
Rainbow-Cats web server listening on 3002
```

不要关闭该窗口。

浏览器地址：

```text
http://127.0.0.1:3002/
```

健康检查：

```text
http://127.0.0.1:3002/api/v1/health
```

预期返回：

```json
{
  "ok": true,
  "data": {
    "service": "rainbow-cats",
    "database": "configured"
  }
}
```

记录：

```text
网页地址：
服务启动时间：
健康检查结果：
```

## 5. 浏览器会话准备

准备两个互相独立的浏览器会话：

- 会话 A：普通 Edge/Chrome 窗口
- 会话 B：Edge InPrivate、Chrome 无痕窗口，或另一款浏览器

不要只使用同一浏览器的两个普通标签页，因为它们可能共享会话状态。

记录：

```text
会话 A：
会话 B：
```

## 6. 创建空间和加入空间

### 6.1 会话 A 创建空间

- [ ] 打开测试地址
- [ ] 点击“创建空间”
- [ ] 输入昵称：`测试创建者`
- [ ] 输入账号：`tester_owner_日期或时间后缀`
- [ ] 输入密码：至少 8 位
- [ ] 提交表单
- [ ] 保存弹出的恢复码
- [ ] 保存页面显示的邀请码
- [ ] 进入“今天”页面

预期结果：

- 创建成功，不出现接口错误
- 页面显示邀请码
- 页面显示当前积分
- 登录页面不要求填写昵称以外的额外字段

记录：

```text
创建者账号：
空间邀请码：
恢复码是否已保存：是 / 否
结果：通过 / 失败
```

### 6.2 会话 B 加入空间

- [ ] 打开同一个测试地址
- [ ] 点击“加入空间”
- [ ] 输入昵称：`测试成员`
- [ ] 输入另一个账号：`tester_guest_日期或时间后缀`
- [ ] 输入密码
- [ ] 输入会话 A 的邀请码
- [ ] 提交表单
- [ ] 进入“今天”页面

预期结果：

- 加入成功
- 两个成员出现在同一个空间
- 两个会话看到同一份业务数据

记录：

```text
成员账号：
加入结果：通过 / 失败
错误信息：
```

## 7. 双人同步基础检查

- [ ] 会话 A 刷新页面后仍在空间中
- [ ] 会话 B 刷新页面后仍在空间中
- [ ] 会话 A 页面显示会话 B 的成员信息
- [ ] 会话 B 页面显示会话 A 的成员信息
- [ ] 一方新增数据后，另一方刷新可以看到
- [ ] 第三位用户使用同一邀请码加入时被拒绝

记录：

```text
同步结果：
第三人限制结果：
```

## 8. 心愿与积分

### 8.1 创建心愿

在会话 A：

- [ ] 进入“心愿与任务”
- [ ] 点击“新增任务”
- [ ] 标题：`周末看电影`
- [ ] 描述：`一起看一部电影`
- [ ] 积分：`20`
- [ ] 保存

预期结果：

- 任务出现在会话 A
- 会话 B 刷新后也能看到

### 8.2 完成心愿

在会话 B：

- [ ] 找到“周末看电影”
- [ ] 点击“完成”
- [ ] 刷新会话 A
- [ ] 检查会话 A 积分增加 20
- [ ] 再次尝试完成同一任务

预期结果：

- 任务只允许完成一次
- 任务发布者获得积分
- 重复完成被拒绝

记录：

```text
完成前创建者积分：
完成后创建者积分：
是否增加 20：是 / 否
重复完成提示：
```

## 9. 礼物、兑换和收藏

### 9.1 上架礼物

在会话 B：

- [ ] 进入“礼物与收藏”
- [ ] 点击“上架礼物”
- [ ] 礼物名称：`奶茶`
- [ ] 描述：`周末奶茶`
- [ ] 积分：`5`
- [ ] 保存

### 9.2 兑换和使用

在会话 A：

- [ ] 刷新礼物页面
- [ ] 点击“兑换”
- [ ] 检查积分减少 5
- [ ] 在“我的收藏”中找到奶茶
- [ ] 点击“使用”
- [ ] 再次尝试使用同一收藏

预期结果：

- 礼物只能被另一位成员兑换
- 兑换后进入收藏
- 使用后变为“已使用”
- 已使用收藏不能重复使用

记录：

```text
兑换前积分：
兑换后积分：
收藏状态：
重复使用提示：
```

## 10. 菜谱

### 10.1 自建菜谱

- [ ] 进入“菜谱”
- [ ] 点击“添加菜谱”
- [ ] 菜名：`番茄炒蛋`
- [ ] 简介：`家常菜`
- [ ] 食材：`番茄、鸡蛋`
- [ ] 步骤：`炒熟即可`
- [ ] 保存
- [ ] 在另一个会话刷新
- [ ] 确认菜谱已共享
- [ ] 打开“查看做法”

### 10.2 官方菜谱未配置分支

本轮环境将 `TIANAPI_KEY` 设置为空：

- [ ] 在官方菜谱搜索框输入“红烧肉”
- [ ] 点击搜索
- [ ] 确认页面提示服务未配置
- [ ] 确认页面没有白屏或未捕获异常

预期提示类似：

```text
服务端尚未配置 TIANAPI_KEY
```

真实 TianAPI 测试需要配置凭据后另行执行，不要把 key 写入本文档。

记录：

```text
自建菜谱结果：
官方搜索未配置提示：
```

## 11. 日程

- [ ] 进入“日程”
- [ ] 点击“新增日程”
- [ ] 标题：`周末约会`
- [ ] 开始时间：未来时间
- [ ] 结束时间：晚于开始时间
- [ ] 备注：`测试共享日程`
- [ ] 保存
- [ ] 另一个会话刷新
- [ ] 首页“接下来”区域显示该日程

记录：

```text
日程是否保存：
另一会话是否同步：
```

## 12. 账本

- [ ] 进入“账本”
- [ ] 点击“记一笔”
- [ ] 金额：`38.50`
- [ ] 分类：`晚餐`
- [ ] 日期：今天
- [ ] 备注：`测试支出`
- [ ] 保存
- [ ] 首页显示最近共同支出
- [ ] 另一会话刷新后可以看到
- [ ] 月度支出金额正确增加

预期结果：

- 金额显示为两位小数
- 不出现 `NaN`
- 不出现空白或错位布局

记录：

```text
支出保存结果：
本月支出变化：
```

## 13. 相册

- [ ] 进入“相册”
- [ ] 点击“添加照片”
- [ ] 图片地址填写：`https://example.com/test.jpg`
- [ ] 填写说明
- [ ] 保存
- [ ] 刷新页面
- [ ] 另一会话刷新并确认记录同步

说明：当前功能保存照片元数据和缩略图地址，不负责本地图片上传。

记录：

```text
相册保存结果：
刷新后结果：
```

## 14. AI 助手

当前没有配置 OpenClaw 时：

- [ ] 进入“AI 助手”
- [ ] 输入任意消息
- [ ] 点击发送
- [ ] 确认提示“尚未配置 OpenClaw 网关”或等价错误
- [ ] 确认页面没有白屏

真实联调需要配置：

```powershell
$env:OPENCLAW_CHAT_URL = '实际网关地址'
$env:OPENCLAW_GATEWAY_TOKEN = '实际令牌'
```

真实联调检查：

- [ ] AI 返回待确认提案
- [ ] 提案未确认前没有写入业务数据
- [ ] 点击“确认”后才创建任务、日程或礼物
- [ ] 提案执行后状态变为已确认

记录：

```text
未配置分支结果：
真实联调结果：N/A / 通过 / 失败
```

## 15. 设置、退出和会话恢复

### 15.1 修改昵称

- [ ] 进入“设置”
- [ ] 修改昵称
- [ ] 保存
- [ ] 刷新页面
- [ ] 确认昵称仍然存在
- [ ] 另一会话刷新并确认成员名称同步

### 15.2 退出登录

- [ ] 点击“退出登录”
- [ ] 返回登录页面
- [ ] 重新登录
- [ ] 确认业务数据仍然存在

### 15.3 会话恢复

- [ ] 登录后刷新浏览器
- [ ] 确认不会回到登录页
- [ ] 关闭并重新打开同一浏览器会话
- [ ] 确认仍能读取空间数据

记录：

```text
昵称修改：
退出登录：
刷新恢复：
重新打开恢复：
```

## 16. 桌面端和移动端布局

使用 Edge 开发者工具设备模拟，建议检查 `390×844`。

### 16.1 登录页

- [x] 标题没有溢出
- [ ] 表单输入框完整可见
- [x] 登录按钮可点击
- [x] 创建空间和加入空间标签可切换

### 16.2 工作区

- [x] 首页没有横向 body 溢出
- [x] 底部导航可横向滚动
- [x] 当前页面导航状态明显
- [ ] 长标题不会遮挡按钮
- [x] 弹窗能在屏幕内滚动
- [ ] 键盘出现时提交按钮仍可操作
- [ ] 刷新后布局不跳动

### 16.3 桌面端

- [x] 左侧导航正常显示
- [x] 内容区没有被侧栏遮挡
- [ ] 三列菜谱卡片布局正常
- [x] 日程、账本和相册没有溢出

记录：

```text
桌面尺寸：1440×900，自动化通过
移动尺寸：390×844，自动化通过
发现的视觉问题：移动端 toast 会遮挡底部导航；已修复并加入 `toastAvoidsNav` 回归断言
```

## 17. 自动化回归

另开 PowerShell 窗口执行：

```powershell
cd D:\program\Rainbow-Cats
. C:\Users\1\.rainbow-cats-load-db.ps1
$env:DATABASE_URL = $env:DATABASE_URL -replace '/rainbow_cats$','/rainbow_cats_manual'
$env:TIANAPI_KEY = ''
cd server
npm run check
npm run test:api
npm run test:ui
npm run test:ui-two-user
npm run audit:db
```

预期结果：

```text
API smoke tests passed
UI smoke 测试返回 `"passed": true`
```

审计结果应包含：

```json
"healthy": true
```

记录：

```text
npm run check：通过
npm run test:api：通过，输出 `API smoke tests passed`
npm run test:ui：通过，9 个页面、桌面 1440×900、移动 390×844、弹窗和未配置服务分支均通过
npm run test:ui-two-user：通过，两个独立 Edge 会话完成加入空间、任务完成、礼物兑换与使用、菜谱同步和会话刷新
npm run audit:db：通过，`healthy: true`
测试数据清理：通过，UI smoke 结束后 users、spaces、missions、sessions 均为 0
错误信息：无未解决错误
```

## 18. 问题记录

每个问题单独复制一份：

```markdown
### 问题编号：BUG-XXX

页面/模块：

严重程度：阻断 / 严重 / 一般 / 轻微

浏览器和设备：

窗口尺寸：

前置条件：

操作步骤：

1.
2.
3.

预期结果：

实际结果：

错误信息或截图路径：

是否可复现：每次 / 偶尔 / 未复现

临时规避方式：

处理状态：待修复 / 已修复待验证 / 已关闭
```

### 问题编号：BUG-001

页面/模块：测试数据库初始化 / `server/schema.sql`

严重程度：阻断

浏览器和设备：Windows PowerShell，PostgreSQL 18 psql

操作步骤：使用测试指南命令导入 schema。

预期结果：全部表和索引创建成功。

实际结果：GBK 客户端无法转换 UTF-8 中文默认值，后续表和索引缺失。

是否可复现：每次

处理状态：已关闭；schema 显式执行 `\encoding UTF8`，严格模式复测通过。

### 问题编号：BUG-002

页面/模块：移动端全局提示 / 底部导航

严重程度：一般

浏览器和设备：Microsoft Edge 153，390×844 模拟视口

操作步骤：在 AI 助手触发未配置 OpenClaw 提示，再切回移动端首页。

预期结果：toast 与底部导航互不遮挡。

实际结果：toast 覆盖底部导航，窄宽度下文案换行不自然。

错误信息或截图路径：`%TEMP%\rainbow-cats-ui-mobile.png`

是否可复现：每次

处理状态：已关闭；toast 上移并限制移动端宽度，截图和自动断言复测通过。

## 19. 测试结论

```text
核心流程是否通过：自动化范围通过，完整手工流程待继续
双人同步是否通过：API 自动化与双浏览器自动化通过，双浏览器手工验收待继续
桌面端是否通过：自动化通过
移动端模拟是否通过：自动化通过
真机测试：未执行
TianAPI：未配置；未配置分支通过
OpenClaw：隔离测试环境使用未配置分支并通过；生产插件与微信绑定另行验收通过
是否发现阻断问题：曾发现 1 个，已修复并复测关闭
最终结论：schema、API、数据库完整性、单会话 UI smoke 与双浏览器自动化通过；可继续执行双会话手工验收和真机验收。
```

## 20. 测试结束清理

先停止网页服务，在运行 `npm start` 的窗口按：

```text
Ctrl + C
```

删除本轮专用测试数据库：

```powershell
. C:\Users\1\.rainbow-cats-load-db.ps1
& 'D:\Program Files\PostgreSQL\18\bin\psql.exe' `
  ($env:DATABASE_URL -replace '/rainbow_cats$','/postgres') `
  -c "DROP DATABASE IF EXISTS rainbow_cats_manual"
```

确认：

- [ ] 网页服务已停止
- [ ] 测试账号已删除或测试库已删除
- [ ] 没有把密码、key、token 写入项目文件
- [ ] 问题记录已补全
- [ ] 测试结论已填写
