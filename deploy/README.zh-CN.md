# `rainbow.251104.xyz` 生产发布

这套发布只针对当前服务器布局：

- 旧源码：`/home/ubuntu/rainbow-cats`
- 旧服务：Ubuntu 用户的 `rainbow-cats.service`，监听 `3001`
- Caddy 站点：`rainbow.251104.xyz`
- 新容器：监听宿主机回环地址 `127.0.0.1:3101`
- PostgreSQL：读取旧服务 `server/.env` 中的 `DATABASE_URL`

发布脚本不会输出 `.env` 或数据库密码。它会在切换域名前完成备份、正式数据库副本迁移、API 联调和真实 Chromium 浏览器测试；任一步失败都会保留旧站点。

## 上传并执行

把发布包上传到服务器的 `/root/rainbow-production-release.tar.gz`，然后以 `root` 执行：

```bash
rm -rf /root/rainbow-production-release
mkdir -p /root/rainbow-production-release
tar -xzf /root/rainbow-production-release.tar.gz \
  --strip-components=1 \
  -C /root/rainbow-production-release
cd /root/rainbow-production-release
bash deploy/deploy-production.sh
```

脚本依次执行：

1. 检查 Docker、Compose、PostgreSQL 客户端、Caddy 和旧配置。
2. 备份旧源码、`.env`、Caddyfile 和 PostgreSQL 自定义格式转储。
3. 构建固定版本的应用镜像和 Playwright 浏览器验收镜像。
4. 从正式备份创建临时数据库，并在副本上执行全部表结构升级。
5. 在数据库副本上执行语法检查、9 项网页回归、API 烟雾测试、数据完整性审计和 Chromium 端到端操作。
6. 副本全部通过后才升级正式数据库，并在 `127.0.0.1:3101` 启动候选容器。
7. 验证容器内 OpenClaw 版本与 Gateway 推理通道。
8. 校验并重载 Caddy，将 `rainbow.251104.xyz` 切换到新容器；公网健康检查通过后停止旧 systemd 服务。

浏览器验收会实际完成“创建空间 → 创建任务 → 退出 → 账号密码登录 → 刷新会话 → 移动端布局 → 删除测试账号”，测试数据只写入临时数据库副本。

## 验证结果

部署成功后，脚本会打印本次备份目录。也可以执行：

```bash
curl -fsS https://rainbow.251104.xyz/api/v1/health

docker compose \
  -p rainbow-cats \
  -f /opt/rainbow-cats/current/compose.production.yaml \
  ps

latest_backup=$(find /opt/rainbow-cats/backups -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
cat "$latest_backup/browser/browser-report.json"
ls -lh "$latest_backup/browser/"
```

健康接口必须返回 `ok: true` 和 `database: "ready"`；容器状态必须为 `Up` 或 `healthy`；`browser-report.json` 必须包含 `"ok": true`。浏览器目录同时保存桌面端和移动端截图。

## 回退

部署完成时会在本次备份目录生成专用 `rollback.sh`。使用脚本最后打印的完整路径执行，例如：

```bash
bash /opt/rainbow-cats/backups/20260920T120000Z/rollback.sh
```

回退脚本先启动旧 systemd 服务，再恢复原 Caddyfile、重载 Caddy 并关闭新容器。数据库升级只新增表、字段和索引，旧服务可以继续读取原有数据，因此正常回退不恢复数据库转储。数据库备份仍保存在同一目录，用于灾难恢复。

## 旧账号迁移

旧站点创建的用户没有用户名和密码。升级后原浏览器令牌继续有效；用户进入“设置 → 设置登录账号”，填写账号和至少 8 位密码后会得到一次性恢复码。保存恢复码后即可在其他设备使用账号密码登录。
