# 生产测试数据清理 Runbook

## 适用范围

本流程仅用于正式数据导入前的一次性初始化。当前数据库只包含测试数据，已经明确批准不创建备份。
脚本会永久删除 `openshude-data` 卷内的 `app.db`、`app.db-wal` 和 `app.db-shm`，但不会删除数据卷或备份卷。

正式学生数据导入后禁止再次使用本流程，必须改用 `restore-database.sh` 和常规备份策略。

## 上线前提

1. 生产版本已包含“导入账号首次强制改密”和“登录页移除演示账号”两个修复。
2. GitHub Actions 的 CI 和 Production Deploy 均已成功。
3. `http://39.96.36.207/api/health` 返回当前目标提交版本。
4. 已安排维护窗口，并确认当前数据库没有需要保留的首页、账号、私信、卡片、宿舍或审计数据。
5. 服务器 `/opt/myapp` 中存在 `reset-production-database.sh`、`compose.prod.yml` 和 `.deployed-image-tag`。

系统当前继续使用 HTTP，因此 `AUTH_COOKIE_SECURE=false`、公网 IP Host 和 HTTP Origin 配置保持不变。Access Token 有效期为 15 分钟，Refresh Token 绝对有效期为 7 天。
正式账号密码和个人信息会以明文 HTTP 传输，应通过安全组、校园网或 VPN 限制访问范围。

## 一次性演练

合并前执行自动化演练：

```bash
uv run pytest -q tests/test_migration_maintenance.py -k fresh_production
bash -n ops/reset-production-database.sh
```

该测试使用全新的临时 SQLite 文件，执行 Alembic、创建初始超级管理员，并断言所有业务表为空。
不得对演练数据库运行 `tests.seed_browser_data`。

## 正式执行

登录服务器并进入部署目录：

```bash
ssh <deployment-user>@39.96.36.207
cd /opt/myapp
```

确认当前部署状态：

```bash
cat .deployed-image-tag
IMAGE_TAG=$(<.deployed-image-tag) docker compose -f compose.prod.yml ps
curl --fail --show-error -H 'Host: 39.96.36.207' http://127.0.0.1/api/health
```

通过终端静默输入一次性管理员密码，避免写入 Shell 历史。密码至少 12 位且不得复用其他系统密码：

```bash
read -r -s -p 'Initial admin password: ' INITIAL_ADMIN_PASSWORD
echo
export INITIAL_ADMIN_PASSWORD
chmod 700 reset-production-database.sh
./reset-production-database.sh RESET-OPENSHUDE-PRODUCTION-DATABASE
unset INITIAL_ADMIN_PASSWORD
```

脚本依次执行：停止 Web 容器、删除旧数据库文件、迁移空库、创建 `admin`、校验 Alembic、校验数据库约束、
断言全部业务表为空、启动容器并验证 Nginx HTTP 反代。

## 执行后验收

1. `http://39.96.36.207/` 可打开默认首页。
2. `/login` 不展示演示账号。
3. 只能用刚设置的一次性 `admin` 密码登录。
4. 首次登录强制修改管理员密码。
5. 管理后台中除 `admin` 外没有其他账号，没有卡片、私信、宿舍、轮次、权限组或审计数据。
6. 创建 2 至 5 个正式试点账号，确认它们必须修改临时密码后才能访问业务页面。
7. 删除或置空 GitHub Actions 的 `INITIAL_ADMIN_PASSWORD` Secret。

脚本执行失败时不要运行测试种子，也不要手工创建表。保留 Web 停止状态，查看脚本输出和容器日志；修复初始化问题后可再次执行同一清库命令。
