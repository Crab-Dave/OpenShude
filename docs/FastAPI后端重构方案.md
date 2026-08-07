# FastAPI 后端重构完整方案

## 1. 文档状态

- 文档用途：作为 OpenShude 后端从 Node.js 迁移到 Python 技术栈的实施、验收和上线依据。
- 当前阶段：方案已确认，重构实现与自动化验收已完成；生产切换由 CI/CD 在合并后执行。
- 清理状态：旧 Node 后端、维护命令和基线测试已删除；Node 仅用于前端语法与 Playwright 验收。
- 当前访问方式：`http://39.96.36.207/`，尚无域名和 HTTPS。
- 重构范围：后端、数据库访问层、数据库迁移、测试、Docker 和 CI/CD；现有前端视觉与交互不重写。
- 数据库目标：重构阶段继续使用 SQLite，保留以后迁移 PostgreSQL 的能力。

只有本文最后的确认项得到确认后，才开始代码重构。

## 2. 结论与总体策略

本次重构采用以下总体策略：

1. 使用 FastAPI、SQLAlchemy 2、Alembic 和 Pydantic 2 重写后端。
2. 保留业务 URL 与错误结构；认证升级为短时 Access Token 和轮换 Refresh Token。
3. 直接映射现有 SQLite 数据库，不在第一阶段顺便清理旧字段或改变业务语义。
4. 使用同步 SQLAlchemy，不使用 `aiosqlite` 和异步 ORM。
5. 生产环境只运行一个 Uvicorn worker，避免放大 SQLite 写锁竞争。
6. 数据库结构只能通过 Alembic 迁移，不允许 Web 进程启动时自动建表、改表或写入演示数据。
7. 使用独立分支完成重构，在数据库副本和独立端口上验收；生产环境不同时运行两套会写同一数据库的后端。
8. 上线时安排短维护窗口：停止旧后端、备份数据库、执行迁移、启动新后端、验证；失败则恢复数据库和旧镜像。
9. HTTP 阶段保持现有可用性并补充能在 HTTP 下生效的保护，但明确接受 HTTP 无法防止链路窃听和中间人攻击这一事实。

这不是为了提高当前小规模系统的吞吐量。主要收益是代码结构、类型校验、数据库迁移、测试能力和未来 Python 生态扩展。

## 3. 重构目标

### 3.1 必须达到的目标

- 现有学生端和管理端功能行为保持一致。
- 现有 24 张业务表及其数据可以安全迁移和读取。
- 现有账号密码无需统一重置。
- 现有 Session 可以选择保留；即使最终决定统一失效，也必须是明确的一次性上线策略。
- 权限、范围、目标保护和审计语义不得弱化。
- 多轮选宿舍的唯一性、容量、状态流转和历史快照保持不变。
- 部署前备份、备份校验、失败回滚、手工恢复继续可用。
- 健康检查同时确认进程和数据库可用，并返回实际镜像版本。
- 生产镜像继续使用非 root 用户。
- 所有现有自动化测试迁移后通过，并补充并发和安全测试。

### 3.2 不属于第一阶段的目标

- 不重写前端框架。
- 不改变 UI 主题和页面信息结构。
- 不改成 JWT 或把令牌保存到 `localStorage`。
- 不迁移 PostgreSQL。
- 不引入 Redis、Celery、消息队列或微服务。
- 不增加通用 Repository、Facade、Manager 等没有实际复用需求的抽象层。
- 不删除现有兼容字段、旧卡片字段或 `role` 字段。
- 不改变现有业务状态名称、权限编码和审计动作语义。
- 不实现 HTTPS；HTTPS 在域名备案和证书可用后单独上线。

## 4. 当前系统基线

当前实现的规模和边界如下：

| 项目 | 当前情况 |
|---|---|
| HTTP 服务 | Node.js 原生 `http` |
| 数据库驱动 | Node 24 内置 `node:sqlite`，同步单连接 |
| 数据库 | SQLite，启用外键和 WAL |
| 数据表 | 24 张 |
| 路由 | 约 61 处路由判断 |
| 会话 | 数据库存储哈希的不透明 Access Token 与轮换 Refresh Token |
| 密码 | scrypt + 独立随机 Salt |
| CSRF | Cookie 会话 + 请求头 Token |
| 授权 | 超级管理员、管理员组、权限编码、年级范围 |
| 部署 | Docker Compose、阿里云 ACR、GitHub Actions、Nginx |
| 数据保护 | 发布前备份、SHA-256、`quick_check`、失败恢复 |

重构时以当前代码、自动化测试、`docs/身份权限设计.md` 和本文共同作为行为基线。发生冲突时，优先顺序为：

1. 用户确认的新需求。
2. `docs/身份权限设计.md` 中的安全和授权规则。
3. 本文明确冻结的 API 与迁移规则。
4. 当前自动化测试。
5. 当前实现细节。

## 5. 目标技术栈

### 5.1 生产依赖

- Python 3.13
- FastAPI
- Uvicorn
- SQLAlchemy 2.x
- Alembic
- Pydantic 2.x
- pydantic-settings
- openpyxl 或 XlsxWriter，用于宿舍 Excel 导出
- 标准库 `hashlib`、`hmac`、`secrets`，用于密码和会话安全

### 5.2 开发与测试依赖

- pytest
- HTTPX
- pytest-cov
- Ruff
- Playwright 浏览器验收继续保留
- 可选：mypy、pip-audit

### 5.3 依赖锁定

使用 `pyproject.toml` 和 `uv.lock` 管理 Python 依赖。CI 和 Docker 必须使用冻结锁文件安装，不能在生产构建时隐式解析不受控的新版本。

生产镜像不再安装 Node.js。CI 可继续安装 Node.js，以执行前端 JavaScript 语法检查和现有 Playwright 验收。

## 6. 目标目录结构

建议采用直接、按领域拆分的结构：

```text
app/
├── __init__.py
├── main.py
├── config.py
├── database.py
├── errors.py
├── security.py
├── models/
│   ├── __init__.py
│   ├── users.py
│   ├── cards.py
│   ├── messaging.py
│   ├── dormitories.py
│   └── administration.py
├── schemas/
│   ├── auth.py
│   ├── cards.py
│   ├── messaging.py
│   ├── dormitories.py
│   └── administration.py
├── api/
│   ├── auth.py
│   ├── cards.py
│   ├── messaging.py
│   ├── dormitories.py
│   └── admin.py
└── domain/
    ├── authorization.py
    ├── dormitory_operations.py
    └── audit.py
alembic/
tests/
ops/
public/
```

设计限制：

- 不增加通用 Repository 层；查询只在确实复用时提取为函数。
- 不使用每张表一套 Service/DAO 的机械分层。
- 路由负责协议转换和调用业务函数，不承载复杂事务。
- 宿舍、授权和审计属于多个接口复用的真实业务规则，放入 `domain/`。
- ORM 模型不直接作为 API 响应；响应必须经过明确的 Pydantic Schema。

## 7. Web 服务与静态资源

### 7.1 前端保持不变

现有 `public/` 目录继续使用，FastAPI 提供：

- `/api/*`：API 路由。
- `/assets/*`、`/vendor/*`、CSS 和 JavaScript：静态文件。
- 其他非 API GET 路径：返回 `index.html`，支持前端页面刷新。

任何 `/api/*` 的未知路径必须返回 JSON `404`，不能回退到 `index.html`。

第一阶段仍由 FastAPI 容器提供静态文件，避免改变 Nginx 和文件发布模型。备案后可以单独评估由 Nginx 直接提供静态资源。

### 7.2 API 文档

- 开发和测试环境允许 `/docs`、`/redoc` 和 `/openapi.json`。
- 生产环境默认关闭这些入口。
- 如以后确需开放，必须通过管理网络或额外认证保护。

## 8. API 合约冻结

### 8.1 路径和方法

前端使用的所有现有路径和 HTTP 方法保持不变，按以下领域迁移：

- 健康：`/api/health`
- 认证：`/api/auth/login`、`/api/auth/refresh`、`/api/auth/logout`
- 当前用户：`/api/me`、密码、我的卡片、我的宿舍
- 卡片：卡片列表、详情、私信入口
- 私信：会话、消息、已读、加入宿舍申请卡片
- 社交保护：拉黑、解除拉黑、举报
- 宿舍：轮次、宿舍列表、创建、申请、审批、成员移除、退出
- 管理：概览、用户、卡片、管理员组、预设学生群组、轮次、宿舍、举报、审计、导出

实施前生成一份机器可读的 API 合约清单，记录每个接口的：

- 方法和路径。
- 请求 JSON 字段。
- 查询参数。
- 成功状态码和响应结构。
- 主要错误状态码与错误编码。
- 学生、组管理员和超级管理员的访问规则。

### 8.2 响应格式

成功响应继续使用当前字段名称，包括现有的 camelCase 和 snake_case 混合形式。第一阶段不统一命名风格。

错误响应继续使用：

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "面向用户的中文说明"
  }
}
```

实现统一 `ApiError` 和异常处理器：

- 业务校验错误转换为当前错误结构。
- Pydantic 请求校验错误转换为受控的 `400 INVALID_REQUEST`，不直接暴露内部模型路径。
- 未预期异常只记录服务端日志，对外返回通用 `500 INTERNAL_ERROR`。
- 范围外资源继续使用受控 `404 RESOURCE_NOT_FOUND`，避免枚举资源。

### 8.3 前端兼容验收

现有 `public/app.js` 原则上不因后端重构修改。只有确认是当前前端缺陷或安全加固必须修改时，才单独提交并说明原因。

## 9. ORM 数据模型策略

### 9.1 第一阶段精确映射

第一阶段精确映射当前表名、列名和关键约束，不顺便重命名或删除字段。包括：

- 现有 `role` 与 `account_type` 同时保留，业务只信任 `account_type`。
- 卡片中仍存在的旧字段继续映射，不在重构提交中清理。
- 审计快照和举报快照继续保留原有 JSON 文本语义。
- 日期时间统一在 Python 中使用 UTC aware `datetime`，但迁移前必须验证 SQLAlchemy 对现有 ISO 文本的解析。
- 性别、账号状态、卡片状态、轮次状态等使用 Python 枚举，同时保留数据库 `CHECK` 约束。

### 9.2 必须保留的数据库约束

- `users.login_identifier` 唯一。
- 用户和室友卡片一对一。
- 会话双方排序且组合唯一。
- 同时最多一个 `OPEN` 轮次的部分唯一索引。
- 每名学生每轮最多属于一个宿舍。
- 宿舍容量固定为 4。
- 同一申请人在同一宿舍最多一个 `PENDING` 申请。
- 宿舍轮次、宿舍、成员和申请的轮次 ID 一致。
- 管理员组成员、权限和范围组合唯一。
- 预设学生群组成员组合唯一。
- 历史结果成员删除源账号后使用 `SET NULL`，文本快照继续保留。

SQLAlchemy 的 ORM 级联不能替代数据库外键级联。历史快照关系不得配置会导致源用户删除时级联删除快照的 `delete-orphan`。

### 9.3 数据库索引复核

在不改变接口行为的前提下，通过 `EXPLAIN QUERY PLAN` 复核并补充以下查询使用的索引：

- Session 按用户清理和按过期时间清理。
- 会话按双方学生和最后消息时间查询。
- 卡片按发布状态、性别和姓名查询。
- 举报按状态和创建时间查询。
- 审计日志按创建时间和授权范围查询。
- 宿舍按轮次、性别和状态查询。
- 成员按轮次和用户查询。
- 申请按轮次、申请人和状态查询。

新增索引必须由 Alembic 管理，并使用实际查询计划验证，不能只根据字段名称机械增加。

### 9.4 避免 N+1

宿舍、管理员组和会话列表必须使用批量加载：

- 一对多集合优先 `selectinload()`。
- 明确的一对一或多对一可使用 `joinedload()`。
- 成员数量、未读数等使用聚合查询或子查询。
- 禁止在列表序列化循环中隐式触发 ORM 懒加载。
- 测试环境可增加查询数量断言，防止列表规模增加后查询数线性增长。

## 10. SQLite 连接与事务设计

### 10.1 连接配置

使用同步 SQLAlchemy Engine：

```python
engine = create_engine(
    settings.database_url,
    connect_args={
        "check_same_thread": False,
        "timeout": 5,
    },
    pool_pre_ping=True,
)
```

每个连接建立时执行：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

每个请求使用独立 Session，请求结束时始终关闭。测试使用内存数据库时必须使用适合跨线程共享的测试配置；生产文件数据库不得使用 `StaticPool`。

### 10.2 运行进程

- 生产运行一个 Uvicorn worker。
- 不使用 Gunicorn 多 worker 扩展 SQLite。
- 密码哈希和同步数据库操作由同步路由在线程池中执行。
- 不在 `async def` 中直接调用同步 SQLAlchemy Session。

### 10.3 事务边界

普通单表更新使用 `with session.begin()`。

以下操作必须在开始读取业务状态前取得 SQLite 写锁，使用短生命周期的 `BEGIN IMMEDIATE` 事务：

- 创建宿舍。
- 审批加入宿舍。
- 退出宿舍或移除成员。
- 开放或截止轮次。
- 生成归档快照。
- 永久删除关联宿舍结果的用户。
- 修改最后一个超级管理员相关状态。

原因是 ORM 和默认事务不能自动防止以下竞态：

- 两个申请同时通过导致宿舍超过 4 人。
- 同一学生同时被两个宿舍批准。
- 两个轮次同时被开放。
- 两个请求同时删除或降级最后一个超级管理员。

约束冲突必须捕获 `IntegrityError` 并转换为稳定业务错误，不能直接返回数据库异常。

### 10.4 宿舍审批的并发验收

并发测试必须使用多个独立数据库连接，同时触发审批并验证：

- 宿舍最终成员不超过 4。
- 同一学生每轮只属于一个宿舍。
- 失败申请得到确定的 409 错误。
- 事务失败不会留下已通过申请但没有成员、或已有成员但申请仍待审批的中间状态。

## 11. 认证、会话和密码迁移

### 11.1 使用不透明 Access 和 Refresh Token

- 登录成功后生成独立的 32 字节随机 Access Token 与 Refresh Token。
- Access Token 绝对有效 15 分钟；Refresh Token 绝对有效 7 天。
- 原始 Token 只保存在 HttpOnly Cookie，数据库只保存 SHA-256。
- Access Token 每次请求都从数据库读取最新账号状态和授权，不把角色或权限写入 Token。
- Refresh Token 每次使用都原子消费并轮换；已消费 Token 在并发宽限期后再次出现时撤销整个设备会话。
- CSRF Token 使用可读 Cookie 和请求头双提交，数据库只保存其哈希。

不使用 JWT，不把 Access 或 Refresh Token 写入响应 JSON、URL、`localStorage` 或 `sessionStorage`。

### 11.2 现有密码兼容

当前密码由 Node `crypto.scryptSync(password, salt, 64)` 生成。Python 使用等价参数：

```python
hashlib.scrypt(
    password.encode("utf-8"),
    salt=salt.encode("utf-8"),
    n=2**14,
    r=8,
    p=1,
    dklen=64,
).hex()
```

比较必须使用 `hmac.compare_digest()`。

上线前使用生产数据库副本中的测试账号验证 Python 结果与现有哈希完全一致。第一阶段不切换 Argon2，不要求用户统一重置密码。

### 11.3 会话迁移选择

迁移会重建 `sessions` 并新增 `refresh_tokens`，所有旧会话统一失效。上线后用户重新登录一次，不维护旧 `session` Cookie、旧表结构或双认证路径。

### 11.4 会话安全改进

- 密码修改成功后撤销全部旧设备会话，并为当前设备签发全新的 Access 与 Refresh Token。
- 密码重置、登录标识变更、账号停用、封禁或永久删除时立即删除全部会话。
- 登录和刷新时顺带清理过期会话；Refresh Token 历史随设备会话级联清理。
- 登录成功后总是创建新设备会话，防止 Session Fixation。
- 浏览器对并发的 Access 过期响应只发起一个 Refresh，并将原请求最多重试一次。
- 登录失败对不存在账号和密码错误返回同一提示。

## 12. HTTP 阶段的安全方案

### 12.1 必须明确接受的限制

HTTP 无法对浏览器与服务器之间的数据进行加密和服务器身份认证。即使使用 CSRF、HttpOnly 和密码哈希，网络路径上的攻击者仍可能：

- 读取用户登录标识和明文密码。
- 窃取 Session Cookie 和 CSRF Token。
- 修改页面 JavaScript 或 API 响应。
- 冒充服务器进行中间人攻击。

FastAPI、ORM 和 Nginx 配置都不能消除这一限制。

因此在 HTTPS 上线前，建议只用于受控范围测试，不正式导入大批真实学生数据，也不传输额外敏感信息。如果仍决定投入正式使用，应将其视为明确接受的剩余风险。

### 12.2 HTTP 期间的 Cookie

Access Cookie 使用 `HttpOnly; SameSite=Lax; Path=/api; Max-Age=900`；Refresh Cookie 使用 `HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=604800`。CSRF Cookie 可被同源 JavaScript 读取，服务端仅保存其哈希。

- 不设置 `Domain`，保持 Host-only Cookie。
- HTTP 阶段不能设置 `Secure`，否则浏览器不会通过 HTTP 发送 Cookie。
- 配置项 `AUTH_COOKIE_SECURE=false` 必须显式设置；生产启动日志打印明显警告。
- 备案和 HTTPS 完成后切换为 `AUTH_COOKIE_SECURE=true`，撤销全部 HTTP 会话并要求重新登录。

### 12.3 CSRF 与来源校验

- 所有非 GET/HEAD/OPTIONS 请求继续要求 `X-CSRF-Token`。
- 使用定时安全比较。
- 对浏览器写请求校验 `Origin`；当前允许来源为 `http://39.96.36.207`。
- 没有 `Origin` 的非浏览器客户端仍必须通过 CSRF，并按接口策略决定是否允许。
- 不启用跨域 API，不返回宽泛 CORS 响应。
- 严禁 `allow_origins=["*"]` 与 Cookie 凭据组合。

### 12.4 Host 与代理信任

- 使用 `TrustedHostMiddleware`，HTTP 阶段允许 `39.96.36.207` 和内部健康检查 Host。
- Uvicorn 只信任来自本机 Nginx 的代理头。
- 不信任任意客户端提交的 `X-Forwarded-For`。
- 审计日志记录经可信代理解析后的真实客户端 IP。

### 12.5 安全响应头

HTTP 阶段即可启用：

- `Content-Security-Policy`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy`
- CSP `frame-ancestors 'none'`

根据当前本地静态资源和 Data URL 头像，初始 CSP 建议为：

```text
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src 'self';
object-src 'none';
base-uri 'none';
form-action 'self';
frame-ancestors 'none'
```

当前前端存在少量内联样式，所以第一阶段的 `style-src` 需要 `'unsafe-inline'`；`script-src` 不允许 `'unsafe-inline'`。以后移除内联样式后再收紧样式策略。

HTTP 阶段不启用 HSTS。HSTS 只在 HTTPS 全站稳定后启用，否则会造成访问故障。

### 12.6 登录保护

- Nginx 按来源 IP 对登录接口限速。
- 应用层对“IP + 登录标识”增加短窗口失败次数限制。
- 应用层限流使用有容量上限和自动过期的进程内记录；当前单 worker 可以保证一致，不把每次失败写入主 SQLite，以免攻击流量放大数据库写锁竞争。
- 限流响应使用 `429`，不泄露账号是否存在。
- 不采用永久账号锁定，避免攻击者恶意锁死其他学生账号。
- 登录和密码修改的 scrypt 操作不得在异步事件循环直接运行。

### 12.7 请求体和内容安全

- Nginx 保持 5 MB 限制。
- FastAPI 应用层保留 4 MB JSON 限制，防止绕过 Nginx 直接访问内部端口；限制逻辑必须覆盖无 `Content-Length` 的分块请求，不能只检查请求头。
- 头像 Data URL 必须验证 MIME、Base64 格式和解码后大小。
- Excel 导出文件名只使用受控轮次编码。
- 所有文本在前端继续 HTML 转义；后端不返回可直接作为 HTML 执行的管理内容。

## 13. 授权与审计迁移

### 13.1 授权顺序

每个请求按以下顺序执行：

1. 验证 Session、过期时间和账号状态。
2. 验证 CSRF、Origin 和请求体。
3. 校验学生端资源所有权、会话参与关系、拉黑关系或宿舍角色。
4. 管理接口声明唯一权限编码。
5. 查询目标资源及其年级范围。
6. 查找是否存在一个有效管理员组同时覆盖权限和目标年级。
7. 校验目标账号保护、轮次状态和字段级限制。
8. 在事务内执行写入和成功审计。
9. 对拒绝的高风险管理请求记录失败审计。

超级管理员绕过管理员组范围，但不绕过业务状态、最后超级管理员保护、确认文本和审计。

### 13.2 授权实现

允许复用的核心函数包括：

- `get_current_user()`
- `require_student()`
- `require_management()`
- `require_super_admin()`
- `authorize(permission_code, target_grade_ids)`
- `authorized_grade_ids(permission_code)`

不要为每个接口堆叠大量含隐式数据库查询的装饰器。目标范围必须在读取目标资源后显式传入授权函数，授权函数返回实际命中的组和范围，供审计记录。

同一请求中的管理员组、权限和范围可以做请求级缓存，但不能做跨请求长期缓存，确保权限修改立即生效。

### 13.3 审计一致性

- 业务写入和成功审计尽量位于同一数据库事务。
- 审计失败时，高风险管理写入应回滚。
- 审计 Schema 明确限制快照字段，禁止记录密码、Salt、Session Token、CSRF Token 和完整私信。
- 审计中的管理员姓名继续保留文本快照，删除账号后仍可追溯。
- 请求 ID 由可信请求头或服务端生成，并返回响应头便于排查。

## 14. 多轮选宿舍迁移要求

以下语义必须作为不可回归规则：

- 轮次只能 `DRAFT -> OPEN -> CLOSED -> ARCHIVED`。
- 同时最多一个 `OPEN` 轮次。
- 只有草稿轮次可以修改参与名单。
- 非参与学生不能创建宿舍或发送申请。
- 每名学生每轮最多一个宿舍，不同轮次互不冲突。
- 只能加入同性别宿舍。
- 宿舍最多 4 人，满员后仍展示。
- 申请必须通过与发起人的私信会话发送。
- 只有当前发起人可以审批和移除成员。
- 发起人退出后由最早加入成员继任；空宿舍删除。
- 轮次截止后学生不能变更，管理员仍可分配房间。
- 轮次归档生成不可变文本快照，归档后禁止修改宿舍。
- 永久删除源用户后，归档姓名和登录标识继续保留。
- 预设学生群组只在使用时复制人员选择，不与轮次建立动态关联。

## 15. Alembic 与数据库迁移

### 15.1 迁移原则

- 生产 Web 进程不执行 `create_all()`。
- 生产 Web 进程不自动执行 Alembic。
- 生产部署脚本在维护窗口显式执行 `alembic upgrade head`。
- 每个迁移必须提供升级验证；涉及数据丢失时不依赖自动 downgrade，而是恢复部署前数据库备份。
- SQLite 修改约束时使用 Alembic batch mode。
- 迁移脚本不得写入演示账号和演示卡片。

### 15.2 Baseline 策略

1. 使用当前最新数据库 Schema 创建 Alembic baseline。
2. 已存在数据库通过 `alembic stamp <baseline>` 标记，不重新创建现有表。
3. 空数据库通过完整迁移创建表。
4. 使用生产数据库副本验证 `stamp` 后 ORM 可完整读取。
5. 后续所有 Schema 修改只增加新 revision。

Baseline 不能只根据 ORM 自动生成后直接使用，必须人工核对：

- 部分唯一索引。
- 复合主键。
- `CHECK` 约束。
- `ON DELETE CASCADE` 和 `SET NULL`。
- 历史快照的非外键文本字段。
- SQLite 表声明和默认值。

### 15.3 数据验证脚本

上线前后执行只读验证：

- `PRAGMA foreign_key_check` 无结果。
- `PRAGMA quick_check` 返回 `ok`。
- 用户、卡片、会话、消息、宿舍和审计数量一致。
- 每轮参与人数、宿舍数和成员数一致。
- 无宿舍超过 4 人。
- 无学生在同一轮属于两个宿舍。
- 最多一个开放轮次。
- 至少一个可登录超级管理员。
- 归档宿舍及成员快照数量一致。
- 抽样验证现有账号密码。

## 16. Excel、备份和恢复工具迁移

### 16.1 Excel 导出

宿舍 Excel 导出已迁移到 Python，并满足以下要求：

- 字段顺序、中文表头和文件名保持不变。
- 按轮次和管理员授权年级过滤。
- 归档轮次从快照导出。
- 导出操作记录审计。
- 用现有测试验证 ZIP/XLSX 文件结构和关键单元格内容。

### 16.2 Python 数据库维护命令

重写为例如：

```text
python -m app.maintenance backup SOURCE TARGET
python -m app.maintenance verify BACKUP
python -m app.maintenance restore BACKUP TARGET
python -m app.maintenance prune DIRECTORY RETAIN
```

行为与当前工具保持一致：

- 使用 SQLite 在线备份 API或 `VACUUM INTO` 生成一致快照。
- 生成 SHA-256 文件。
- 恢复前校验摘要和 `quick_check`。
- 恢复使用同目录临时文件和原子替换。
- 清理 `-wal` 和 `-shm` 前必须确保应用已停止。
- 保留最近 10 份自动备份。

必须先让 Python 维护工具通过现有数据库维护测试，才能从生产镜像移除 Node 维护工具。

## 17. Docker 方案

### 17.1 镜像

目标镜像基于 `python:3.13-slim`，要求：

- 使用锁文件冻结安装。
- 不安装编译工具到最终运行层，必要时使用多阶段构建。
- 创建非 root `app` 用户。
- 为避免现有 Docker Volume 权限变化，优先让 `app` 使用与当前 `node` 用户一致的 UID/GID 1000。
- `/app/data` 和 `/app/backups` 继续挂载现有外部 Volume。
- `public/`、Alembic 配置和维护命令包含在镜像中。
- 关闭 Uvicorn Server 响应头。

启动命令类似：

```text
uvicorn app.main:app --host 0.0.0.0 --port 4173 --workers 1 --no-server-header
```

### 17.2 Compose

保留：

- 必须显式提供 SHA 镜像标签。
- `127.0.0.1:4173:4173`，不直接暴露应用端口到公网。
- 外部数据和备份 Volume。
- 日志滚动限制。
- `APP_VERSION`。

新增或调整：

- Python 配置环境变量。
- `ACCESS_TOKEN_MINUTES=15`、`REFRESH_TOKEN_DAYS=7`。
- `AUTH_COOKIE_SECURE=false`，HTTP 阶段显式配置。
- `ALLOWED_HOSTS=39.96.36.207,127.0.0.1,localhost`。
- `ALLOWED_ORIGINS=http://39.96.36.207`。
- 健康检查改用 Python 标准库请求，避免在镜像中安装 curl 或保留 Node。

## 18. CI 方案

CI 拆分为以下步骤：

1. Checkout。
2. 安装冻结的 Python 依赖。
3. Ruff 格式和静态检查。
4. Alembic revision 链完整性检查。
5. Python 单元和 API 测试。
6. 旧数据库迁移测试。
7. 并发宿舍事务测试。
8. Node 前端语法检查。
9. Playwright 浏览器验收。
10. Shell 语法检查。
11. Compose 配置验证。
12. Docker 镜像构建。
13. 对构建镜像执行健康检查。

可选增加：

- `pip-audit` 依赖漏洞检查。
- 覆盖率报告；权限、认证和宿舍领域应设置较高覆盖要求。
- 检查 Alembic 模型差异，防止修改模型但忘记生成迁移。

## 19. 生产部署和回滚流程

SQLite 无法安全实现两个不同 Schema 版本后端的无停机双写，因此采用短维护窗口。

### 19.1 发布前提

- CI 全部通过。
- 新镜像已使用提交 SHA 推送。
- 数据库迁移已在生产数据库副本演练。
- Python 备份恢复演练通过。
- 已记录当前镜像 SHA 和 Compose。
- 服务器备份 Volume 空间足够。
- 明确维护窗口和回滚负责人。

### 19.2 正常发布顺序

1. 拉取新镜像。
2. 验证新 Compose。
3. 记录旧容器、旧镜像和旧 Compose。
4. 停止旧 Web 容器，阻止新写入。
5. 使用新镜像对静止数据库执行部署前备份。
6. 校验 SHA-256、`quick_check` 和 `foreign_key_check`。
7. 执行 `alembic upgrade head`。
8. 执行迁移后数据验证脚本。
9. 启动新 Web 容器。
10. 等待容器健康。
11. 验证 `/api/health` 返回目标 SHA。
12. 通过 Nginx 和公网 IP 验证健康接口及首页。
13. 使用测试账号完成登录、卡片、宿舍和管理工作台冒烟测试。
14. 更新 `.deployed-image-tag`。
15. 保留当前和上一版本镜像，清理更旧镜像。

### 19.3 失败回滚顺序

1. 停止新 Web 容器。
2. 使用已校验的部署前备份恢复数据库。
3. 再次执行 `quick_check` 和数据验证。
4. 恢复旧 Compose。
5. 启动旧镜像。
6. 验证旧版本健康和反向代理。
7. 保留失败 Compose、迁移日志和新容器日志。
8. 回滚任何一步失败时停止自动清理并输出人工恢复指令。

不能仅运行 `alembic downgrade` 后启动旧镜像。数据库备份恢复是跨技术栈回滚的主要保障。

## 20. 分阶段实施计划

### 阶段 0：行为冻结与技术验证

- 建立重构分支。
- 生成 API 合约清单。
- 复制当前数据库作为迁移样本。
- 创建最小 FastAPI 应用。
- 验证 SQLAlchemy 读取现有数据库。
- 验证现有 scrypt 密码。
- 验证现有 Session 和 CSRF。
- 实现一个宿舍并发审批原型。
- 对比 Node 与 FastAPI 的基础性能。

退出条件：密码、会话、事务和数据库映射均可行，否则暂停完整重构。

### 阶段 1：基础设施与模型

- Python 项目和锁文件。
- 配置、日志、错误处理和请求 ID。
- SQLAlchemy Engine、Session 和 PRAGMA。
- 全部 ORM 模型。
- Alembic baseline 和空库创建。
- 现有数据库 stamp、读取和一致性测试。
- 静态文件与 SPA fallback。

### 阶段 2：认证与安全基线

- 登录、登出、当前用户和首次改密。
- 不透明 Session 和 CSRF。
- HTTP Cookie 配置。
- Host、Origin、代理和安全响应头。
- 登录限流。
- 账号状态和 Session 撤销。

### 阶段 3：学生端功能

- 卡片创建、修改、发布、列表和详情。
- 私信、已读、拉黑和举报。
- 轮次查询、宿舍列表、创建和退出。
- 私信申请卡片、审批和移除成员。
- 历史轮次和归档结果查询。

### 阶段 4：权限和管理端

- 权限白名单和管理员组。
- 年级范围和同组匹配。
- 账号导入、身份、状态和永久删除。
- 卡片治理。
- 预设学生群组。
- 轮次创建、配置、开放、截止和归档。
- 宿舍位置、关闭和按轮次导出。
- 举报处理和审计日志。

### 阶段 5：运维迁移

- Python Excel 导出。
- Python 数据库备份、验证、恢复和清理。
- 新 Dockerfile 和 Compose。
- CI 和生产部署工作流。
- 自动回滚演练。

### 阶段 6：并行验收

这里的“并行”仅指对比测试，不是两个后端同时写生产数据库：

- Node 后端使用数据库副本 A。
- FastAPI 后端使用同源数据库副本 B。
- 同一黑盒合约测试分别运行。
- 对关键响应做规范化后比较。
- Playwright 在 FastAPI 上完整运行。
- 执行并发、迁移、备份和恢复测试。

### 阶段 7：生产切换

- 安排维护窗口。
- 执行第 19 节发布流程。
- 上线后重点观察 24 小时。
- 保留旧镜像和部署前数据库备份，确认稳定后再按策略清理。

## 21. 测试与验收矩阵

### 21.1 API 合约

- 所有现有成功响应状态码和关键字段一致。
- 错误响应使用现有 `error.code` 和 `error.message`。
- 查询参数、空列表、资源不存在和重复提交行为一致。
- Excel 文件名、类型和关键单元格一致。

### 21.2 认证安全

- 正确密码和现有 scrypt 哈希登录成功。
- 不存在账号和错误密码返回相同错误。
- 缺少、错误和过期 Access Token 会尝试一次 Refresh；Refresh 无效或过期后要求重新登录。
- Refresh Token 每次使用都轮换，旧 Token 重放会撤销设备会话。
- 所有写请求缺少或伪造 CSRF 时被拒绝。
- 非法 Origin、Host 和代理头被拒绝或忽略。
- 停用和封禁立即使 Session 失效。
- 登录限流生效且不会泄露账号存在性。
- 生产文档入口关闭。

### 21.3 资源权限

- 学生只能修改自己的卡片。
- 会话只有双方可读写。
- 拉黑后双方不能查看卡片或联系。
- 普通管理员不能读取完整私信。
- 管理员只能操作授权年级。
- 权限和范围必须由同一个管理员组满足。
- 管理员不能管理自己或其他有效管理员。
- 最后一个超级管理员不能停用、删除或降级。
- 越权资源不泄露存在性。

### 21.4 宿舍和轮次

- 同性别、参与名单和每轮唯一宿舍规则。
- 满员宿舍展示但不能申请。
- 并发审批不超过 4 人。
- 同一学生并发申请不能进入两个宿舍。
- 发起人退出正确继任，空宿舍删除。
- 截止后学生所有变更被拒绝。
- 归档后管理员修改被拒绝。
- 两轮结果独立保留。
- 删除账号后归档文本快照保留。
- 同时开放两个轮次失败。

### 21.5 数据迁移与运维

- 空数据库可通过 Alembic 完整创建。
- 当前数据库可 baseline/stamp 并启动。
- 旧角色和旧宿舍迁移测试继续通过。
- 备份、摘要、校验、恢复和清理通过。
- 迁移失败自动恢复数据库和旧镜像。
- 健康接口返回正确版本。
- Nginx IP 访问首页和 API 正常。

### 21.6 浏览器

- 学生卡片、搜索、详情和编辑。
- 私信和申请卡片。
- 宿舍列表、创建、审批和退出。
- 历史轮次结果。
- 超级管理员和组管理员工作台。
- 预设学生群组和一键选择。
- 宿舍 Excel 下载。
- 桌面端和移动端无新增布局问题。

## 22. 性能验证

当前系统规模较小，性能目标采用“不得出现显著回退并消除明显 N+1”，而不是追求高 QPS。

使用固定数据集分别测试 Node 和 FastAPI：

- 500 和 2000 名学生。
- 每人一张卡片。
- 100 个会话及足量消息。
- 250 个宿舍和多个历史轮次。
- 20 个并发读取。
- 多个并发审批写入。

记录：

- p50、p95、p99 延迟。
- 每个接口 SQL 查询次数。
- SQLite busy/locked 错误数。
- 登录 scrypt 耗时。
- 进程 RSS。
- Docker 镜像大小和启动时间。

验收标准：

- 无 SQLite `database is locked` 未处理错误。
- 列表查询数不随列表项目数线性增长。
- 登录、卡片、会话和宿舍核心接口的 p95 不出现无法解释的数量级回退。
- 所有并发业务不变量成立。

## 23. 日志与可观测性

- 使用结构化 JSON 日志输出时间、级别、请求 ID、路径、方法、状态码和耗时。
- 不记录请求密码、Cookie、CSRF、Session Token、头像 Data URL 或完整私信正文。
- 5xx 记录异常堆栈；4xx 只记录必要摘要。
- 健康检查访问可以降级日志等级，避免污染日志。
- 数据库锁等待和超过阈值的慢请求记录警告。
- 审计日志属于业务数据，应用日志不能替代审计表。
- Docker 继续限制单文件 10 MB、保留 3 个文件。

## 24. 预计工作量

| 阶段 | 预计工作量 |
|---|---:|
| 技术验证与合约冻结 | 2–3 人日 |
| 模型、Alembic 和基础设施 | 4–6 人日 |
| 认证与学生端 API | 6–9 人日 |
| 权限、管理端和宿舍轮次 | 8–12 人日 |
| 运维、测试和安全加固 | 6–9 人日 |
| 上线演练和生产切换 | 2–4 人日 |
| 合计 | 28–43 人日 |

实际时间取决于 API 合约差异、ORM 映射问题和生产数据库迁移演练结果。不能通过跳过权限、并发和恢复测试压缩上线时间。

## 25. 提交和评审策略

重构过程拆成可审查提交，避免一个超大提交：

1. `chore: scaffold FastAPI backend`
2. `feat: map existing database with SQLAlchemy`
3. `feat: migrate authentication and session security`
4. `feat: migrate student APIs`
5. `feat: migrate dormitory workflows`
6. `feat: migrate scoped administration`
7. `feat: port database maintenance and exports`
8. `ci: deploy FastAPI backend with migrations and rollback`
9. `test: verify Node and FastAPI contract parity`

在最终切换前允许重构分支存在中间提交，但主分支上的每个合并点必须通过对应 CI。未经确认不推送、不部署生产。

## 26. 开始重构前需要确认的决策

以下项目作为默认建议，请在开始重构前确认：

1. **范围**：只重构后端、数据库访问和运维，前端保持现有 API 合约。
2. **数据库**：继续使用 SQLite，FastAPI 单 worker；暂不迁移 PostgreSQL。
3. **ORM**：使用同步 SQLAlchemy 2，不使用异步 ORM。
4. **迁移**：第一阶段精确映射现有 Schema，不清理旧字段。
5. **密码**：保持现有 scrypt 算法，现有账号无需重置密码。
6. **会话**：迁移到短时 Access 与轮换 Refresh Token，上线统一清空旧 Session。
7. **安全**：HTTP 阶段不设置 Cookie `Secure`、不启用 HSTS，但保留 CSRF 并增加 Host、Origin、限流和安全响应头。
8. **HTTP 风险**：在 HTTPS 完成前不正式导入大批真实学生数据；如果提前正式使用，则明确接受密码和 Session 可能被链路窃听的风险。
9. **部署**：接受首次切换需要短维护窗口，不做 SQLite 双写和零停机迁移。
10. **迁移执行**：Alembic 只由部署脚本显式执行，应用启动不自动迁移。
11. **回滚**：跨技术栈回滚以恢复部署前数据库备份和旧镜像为准。
12. **依赖**：使用 Python 3.13、`pyproject.toml` 和 `uv.lock`。

## 27. 开工门槛

满足以下条件才进入完整重构：

- 本文方案获得确认。
- 当前主分支 CI 通过且工作区干净。
- 已生成并保存生产数据库备份。
- 已准备脱敏或可控的生产数据库副本。
- FastAPI 技术验证证明现有密码、Session 和数据库均可兼容。
- 宿舍并发审批原型证明不会超员或重复入舍。
- Python 备份恢复工具通过独立测试。
- 生产维护窗口和回滚步骤得到确认。

如果技术验证阶段任一关键条件失败，应先更新本文并重新评审，不直接进入全量接口迁移。
