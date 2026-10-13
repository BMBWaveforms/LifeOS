# LifeOS / 苟活：给开发与部署 Agent 的说明

本文件适用于整个仓库。目标是让团队 Agent 能拉取代码、理解业务约束、运行检查，并在已指定的机器上部署正确的版本。

## 先读这些文件

1. `README.md`：产品、体验方式和开发入口。
2. `docs/Agent部署与验收.md`：按步骤部署、验证、更新及排障。
3. `compose.yml`、`deploy/compose.env.example`：实际服务和部署参数。
4. 涉及业务改动时，再读 `docs/架构与接口.md`、相关 `prompts/` 和 `tests/`。

当前源码仓库是 `https://github.com/shuaishuaisylas/LifeOS`，主分支是 `main`。开始前检查工作树和分支；已有用户修改时保留它们，只调整本次任务需要的文件。

## 先确定运行目标

| 用户目标 | 应使用的入口 | 验证方式 |
|---|---|---|
| 部署完整应用、真实问答与长期记忆 | 仓库根目录 `compose.yml`，Docker Compose | 容器、健康接口、登录、真实问答与摘要 |
| 修改代码并调试 | Python 后端 + `scripts/frontend_server.py`，或重新构建 Docker | 后端测试及相关真实交互 |
| 只看 UI、展示交互 | `scripts/build_preview.py`、GitHub Pages | 静态页面及虚构浏览器记录 |

用户说“部署这个项目”时，默认部署完整 Docker 应用。GitHub Pages 地址 `https://shuaishuaisylas.github.io/LifeOS/` 只运行静态模拟，不是完整应用，也不连接模型。

部署前明确目标机器、访问方式和模型配置文件路径。未提供服务器时，可先完成本地构建与配置检查；缺少 SSH 地址或可用凭据时询问这些缺失信息，不自行购买服务器或猜测主机。已有授权和参数后继续执行常规构建、启动与验收，不重复要求确认。

## 当前技术与文件职责

- 前端：原生 HTML/CSS/JavaScript，正式文件在 `frontend/`；无需 Node 构建应用。
- 后端：Python + FastAPI + Uvicorn；Docker 使用 Python 3.12。
- 模型：`backend/model.py` 用 `httpx` 调用 OpenAI 兼容的 HTTPS Chat Completions 接口。
- Harness：`AgentService` 在 Python 中组织模型、上下文、工具循环和摘要/回访任务。
- 工具：仅 `search_entries(query)`、`get_entry(guide_id)` 两个只读指南工具；声明在 `prompts/tools.json`，分发在 `backend/model.py`，检索实现及校验在 `backend/store.py`。
- 数据：`data/guide.json` 是 2026-10-12 固定指南快照，共 687 条。SQLite 和账号配置保存在运行目录或 Docker 卷中。
- 提示词：`prompts/chat.md`、`summary.md`、`home.md`；每次调用读取，Docker 只读挂载。
- `skills/guide-only.md` 是维护约束文档，未作为运行时 Skill 自动加载。
- `preview/adapter.js` 只用于静态预览，不接入正式前端或后端。

后端只提供 JSON API，静态页面由前端服务提供。Docker 前端通过同源 `/api` 转发到 `backend:8781`；应用代码、模型接入和运行不需要 Dify。

## 改动时保留的产品约束

1. 建议只能来自固定指南。候选标题不是证据；引用前必须在本轮完整回读条目，后端负责核对并生成来源正文。
2. 技术错误与“指南未覆盖”分开；模型或工具失败不能伪装成正常无答案。
3. 开启记忆时，每轮已校验的回话后生成模型摘要，记录明确的用户状态、问题、真实咨询过的指南及进展。记忆关闭后停止长期读写。
4. 当前答复会等待摘要处理，再一起返回答复与保存状态。摘要失败应显示未写入。
5. 首页只问进展和是否继续咨询，不直接输出指南正文。已解决经历可保留，但退出回访。
6. 记录的 `active/superseded` 与问题的 `resolved/unresolved/unknown` 是独立状态。
7. 用户归属、实际回读记录和记忆 revision 由后端校验；删除、纠正和设置变更会使陈旧结果失效。
8. 调整指南快照、模型输出契约或工具参数时，同步提示词、校验、测试与说明；保留指南署名及许可。

## 部署配置与数据

完整步骤见部署手册。新部署将 `deploy/compose.env.example` 复制成忽略的 `.env.compose`；后续统一使用 `docker compose --env-file .env.compose ...`。

- `API_CONFIG_PATH`：宿主机模型 JSON 文件路径；Compose secret 挂载至 `/run/secrets/model_api`。
- `API_CONFIG_FILE`：后端读取配置的路径；本地 Python 在 `.env` 中设置，容器内由 `compose.yml` 设置。它与宿主机的 `API_CONFIG_PATH` 不同。
- `WEB_PORT`：宿主机前端端口，默认 8780。改变它时同步浏览器地址对应的 `ALLOWED_ORIGINS`。
- `COOKIE_SECURE`：浏览器通过 HTTPS 访问时设为 `true`；本地或 SSH 隧道的 HTTP 访问保持 `false`。
- `COMPOSE_PROJECT_NAME`：固定一个部署项目名，并在启动、日志、更新及备份时使用同一配置。更换名字会指向另一套卷和账号。
- `memory_data`：包含数据库、账号哈希、profiles 和首次密码；重建应用容器保留卷。

保持后端单 worker、单实例：登录会话和运行状态在进程内，SQLite 保存长期记忆。当前不能直接增加 Uvicorn worker 或横向扩容后端。

前端默认绑定宿主机 `127.0.0.1`，后端不发布宿主机端口。服务器可经 SSH 隧道预览；公网域名通过同机 HTTPS 网关转发到前端。不要为了外网访问直接暴露后端或停掉无关服务。

后端镜像以 `appuser`（UID 10001）运行。文件来源的 Compose secret 使用绑定挂载，不能假定文件权限会自动变成可读；在目标机器执行手册中的容器读取权限检查，再处理宿主机所有权或 UID 映射。

保留已有 API 配置、账号和运行卷。`down -v`、删除运行文件、覆盖数据库和 `docker system prune --volumes` 不属于普通代码更新；仅在任务明确要求删除相应数据时执行。密钥、密码、Cookie 和用户会话不进入 Git、Issue、公开日志或静态预览。

## 验证和汇报

修改业务代码后，运行后端测试；修改前端或预览时，检查 JS 语法并验证相关 UI；修改部署文档时，检查涉及的命令和 Compose 配置。常用检查：

```sh
python -m pytest -q
node --check frontend/app.js
node --check preview/adapter.js
python3 scripts/build_preview.py
python3 scripts/check_publish.py
docker compose --env-file .env.compose config --quiet
```

测试需要先安装 `requirements-lock.txt` 和 `requirements-dev.txt`；FakeModel 测试不需要 API Key。Node 只用于 JavaScript 检查，不是正式应用的运行依赖。

`/health` 返回 200 只证明后端能响应；`model.configured=true` 只证明配置可解析，不证明模型 Key、余额或模型名可用。真实模型、摘要、解决后退出回访和重启后的持久化按手册分别验收。

交付时报告部署机器/访问地址、Git SHA、Compose 项目名、检查结果及尚未验证的能力。缺少模型凭据时明确写“已启动，真实模型未验收”；只有静态 Pages 时明确写“静态交互预览”。不要把容器启动、静态模拟或测试模型通过写成真实服务全部验收完成。
