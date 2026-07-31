# 合住

面向校内大学生与准大学生的自由双选室友系统。项目包含学生端、管理后台、FastAPI API 与 SQLite 数据库。

## 运行要求

- Python 3.13
- uv
- Node.js 24（仅用于前端语法、旧后端合约基线和浏览器验收）

## 启动

```powershell
uv sync --frozen
uv run alembic upgrade head
$env:INITIAL_ADMIN_PASSWORD = "Replace-With-A-Strong-Password"
uv run python -m app.maintenance bootstrap-admin data/app.db
uv run uvicorn app.main:app --host 127.0.0.1 --port 4173 --workers 1
```

打开 `http://127.0.0.1:4173`。

Web 进程不会自动创建表、迁移或写入演示数据。首次使用空数据库时，必须先显式运行 Alembic 和
`bootstrap-admin`；已有数据库会保留现有账号、密码和 Session。

仓库开发数据库中的演示账号为：

| 角色 | 登录标识 | 密码 |
| --- | --- | --- |
| 管理员 | `admin` | `Admin123!` |
| 学生 | `2026001` 至 `2026012` | `Student123!` |

演示密码只用于本地开发。空数据库不会自动生成这些演示账号，可在管理员工作台导入测试账号。

## 功能

- 管理员批量导入正式账号，独占修改学生姓名、年级和性别。
- 学生编辑并直接发布室友卡片，按女生/男生分页浏览和筛选。
- 一对一私信、举报、拉黑与消息访问控制。
- 学生新建宿舍并立即成为发起人，或浏览同性别的未满/已满宿舍。
- 加入申请通过私信申请卡片发送，由宿舍发起人审核。
- 超级管理员可创建多次选宿舍轮次并配置每轮参与学生；每名学生在每轮最多加入一个 4 人宿舍。
- 超级管理员可维护可复用的预设学生群组，在轮次参与人和管理员组成员配置中一键添加群组成员。
- 轮次按草稿、进行中、已截止、已归档流转；归档时生成不可变结果快照，同一批学生可参加后续轮次且历史结果继续保留。
- 进行中的轮次允许满员宿舍继续退出，无成员时删除宿舍；截止后学生不能再变更宿舍。
- 超级管理员配置管理员组、固定权限白名单、成员和年级范围；组管理员可在学生端与管理工作台之间切换。
- 管理操作按“同一管理员组的权限 + 年级范围”授权，账号治理、卡片治理、按轮宿舍查看与导出、举报和审计均由后端强制校验。
- 学生注销后保留资源，管理员可执行永久删除。
- 人员候选列表、室友卡片、会话、宿舍成员及管理后台人员列表均支持按姓名搜索。

## 验证

```powershell
$env:UV_CACHE_DIR = ".uv-cache"
uv run ruff format --check .
uv run ruff check .
uv run pytest
$env:DB_PATH = "tests/alembic-check.db"
uv run alembic upgrade head
uv run alembic check
npm.cmd test
node scripts/browser-check.js
```

pytest 使用独立临时数据库，覆盖迁移、权限、安全、并发和备份恢复。Node 测试保留为旧后端行为基线。
浏览器检查默认使用本机 Microsoft Edge，也可通过 `BROWSER_EXECUTABLE` 指定浏览器；运行前需在 `APP_URL`
指定的地址启动 FastAPI 测试服务。

## 配置

- `PORT`：HTTP 端口，默认 `4173`。
- `DB_PATH`：SQLite 数据库路径，默认 `data/app.db`。
- `ALLOWED_HOSTS`：允许的 Host JSON 数组；生产环境必须包含公网 IP 或后续域名。
- `ALLOWED_ORIGINS`：额外允许的 Origin JSON 数组。
- `DOCS_ENABLED`：是否开放 OpenAPI 文档；生产环境设为 `false`。
- `INITIAL_ADMIN_PASSWORD`：生产环境首次创建超级管理员时必须提供的至少 12 位一次性密码；首次登录后系统会强制修改。已有数据库不再需要保留该变量的值。
