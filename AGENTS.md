# LifeOS / 苟活：给开发与部署 Agent 的说明

本文件适用于整个仓库。目标是让团队 Agent 能拉取代码、理解业务约束、运行检查，并在已指定的机器上部署正确的版本。

长期记忆升级还需遵守 `docs/长期记忆管理.md`：原话来源是事实层，主题摘要仅是可丢弃缓存；不得从累计模型摘要或 SDK transcript 恢复已删除内容。新增模型整理使用无工具 SDK 临时任务；发送排队来源前和提交前都校验来源指纹/账号/记忆设置/业务版本。记忆按相关性与估算 token 预算选取，不恢复固定“最近12条”。原话会持久保存，因此界面必须提供来源查看和删除，不能只写“保存摘要”。

## 先读这些文件

1. `README.md`：产品、体验方式和开发入口。
2. `docs/Agent部署与验收.md`：按步骤部署、验证、更新及排障。
3. `compose.yml`、`deploy/compose.env.example`：实际服务和部署参数。
4. 涉及业务改动时，再读 `docs/架构与接口.md`、`docs/前端接入与验收.md`、`docs/执行层与测试台.md`、`docs/评测工作台.md`、相关 `prompts/` 和 `tests/`。

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

- 前端：原生 HTML/CSS/JavaScript，唯一产品入口是团队 Horizon 页面 `frontend/index.html`，固定场景在 `landing-scenes.mjs`，真实接口在 `service.mjs`。来源为 BMBWaveforms/LifeOS b205c20，模块已提升至根目录，旧产品不再提供入口。旧测试页不再作为产品首页；`/workbench.html` 仅作内部测试工具；无需 Node 构建应用。
- 后端：Python + FastAPI + Uvicorn；Docker 使用 Python 3.12。
- 模型：问答统一由 SDK 使用 Anthropic 兼容入口调用 DeepSeek；`backend/model.py` 的摘要、首页任务和评测语义判定同样使用无工具、无历史恢复的SDK临时任务，不再直接调用 Chat Completions。
- Harness：`AgentService` 每轮提供权威业务状态和两个指南工具；`backend/executors.py` 仅提供 claude-sdk，SDK 负责连续对话及普通历史压缩；`backend/sdk_sessions.py` 管隔离持久化、恢复授权与过期。旧 AGENT_RUNTIME 不再选择执行层，显式 native 请求拒绝。
- SDK：锁定 claude-agent-sdk 0.2.166，包含 Claude Code CLI；不需要宿主机另装 Claude Code。所有模型任务使用 Anthropic 兼容入口；摘要/首页/判定不续接聊天历史。
- 工具：仅 `search_entries(query)`、`get_entry(guide_id)` 两个只读指南工具；声明在 `prompts/tools.json`，共同分发及权限检查在 `backend/tools.py`，检索实现及结果校验在 `backend/store.py`。
- 团队账号：`backend/accounts.py` 按私有 `TEST_ACCOUNT_PASSWORD` 补齐 test1 到 test10，并同步这些测试账号的密码；保留已有身份、其他账号凭据和数据。新密码经独立盐的 PBKDF2 保存，账号文件原子更新；密码不写入公开文档或源码配置。
- 评测工作台：`frontend/workbench.html`、`evaluation.js` / `evaluation.css`；`workbench.js` 保留自由测试。`backend/workbench.py` 管隔离会话，`prompt_tests.py` 管七个提示词环节的隔离实验；`evaluation.py` 管版本化评测集、队列、五环节及整体判定、复核与导出。共享定义，个人运行与结果；用例/方案分别隔离。批量会话放在 evaluation-runs/{job_id}/workbench，自由测试 API 不能续接；旧批量会话保留并标 scope=evaluation。
- 数据：`data/guide.json` 是 2026-10-12 固定指南快照，共 687 条。SQLite 和账号配置保存在运行目录或 Docker 卷中。
- 提示词：`prompts/modules/*.md` 为七个业务初始文档；`prompts/contracts/*.md` 单独维护输出契约。组合固定契约全文，导入采用本部署契约；不得通过工作台编辑扩权或绕过后端校验。`backend/prompts.py` 首次初始化不可变版本；已有部署以 prompts.sqlite 的版本和启用记录为准，改仓库文档不会自动覆盖。工作台可导入/导出 .md 和组合 JSON；编辑、测试、产品启用分别操作。旧 chat.md/summary.md/home.md 仅保留独立 AgentService 无 registry 时的兼容入口。
- `skills/guide-only.md` 是维护约束文档，未作为运行时 Skill 自动加载。
- 静态预览由 `scripts/build_preview.py` 复制同一 Horizon 产品白名单，并固定 `runtime.json` 的 real_api_enabled=false；DemoService 只使用虚构浏览器记录。不得打包工作台、后端、账号或运行数据。

后端只提供 JSON API，静态页面由前端服务提供。Docker 前端通过同源 `/api` 转发到 `backend:8781`；应用代码、模型接入和运行不需要 Dify。

## 改动时保留的产品约束

1. 建议只能来自固定指南。候选标题不是证据；引用前必须在本轮完整回读条目，后端负责核对并生成来源正文。
2. 技术错误与“指南未覆盖”分开；模型或工具失败不能伪装成正常无答案。
3. 产品自动记忆，每轮已校验的回话后生成模型摘要，记录明确的用户状态、问题、真实咨询过的指南及进展。产品不提供记忆开关或手动纠正，仅允许删除；隔离评测仍可模拟开关与纠正。部署启动会将产品账号旧关闭状态迁移为开启并提升 revision，保留账号与来源。
4. 当前答复会等待摘要处理，再一起返回答复与保存状态。摘要失败应显示未写入。
5. 首页只问进展和是否继续咨询，不直接输出指南正文。已解决经历可保留，但退出回访。
6. 记录的 `active/superseded` 与问题的 `resolved/unresolved/unknown` 是独立状态。
7. 用户归属、实际回读记录和记忆 revision 由后端校验；删除、纠正和设置变更会使陈旧结果失效。
8. 调整指南快照、模型输出契约或工具参数时，同步提示词、校验、测试与说明；保留指南署名及许可。
9. SDK 不读取用户/项目配置，不开放 Bash、文件和 Web 工具。每轮创建新工具绑定和 run_id，通过私有提交标记恢复该用户该对话的 SDK 历史，不使用 continue 查最近会话。首轮发送前分配稳定应用ID，删除先写跨重启的私有撤销标记；begin、摘要保存前及commit都须校验。仅在来源校验、摘要处理及最终 revision 检查通过后提交恢复标记；失败/中断记录不得恢复。工具失败后 Python 拒绝整轮结果。
10. 单环节提示词测试是固定上游输入的受控实验，不表示生产链路独立执行七次；自动校验只检查契约/来源，质量需人工判断。产品、自由测试和批量任务统一 SDK；A/B 比较提示词方案。历史 native 结果可查看/导出，不能续接或用旧快照重跑；不保存模型私有思维链、API Key 或请求头。执行成功与质量判定独立；系统语义判定可能出错，保留人工复核和待确认，整体结果不能取五项平均。

11. 批量任务固定用例版本、提示词全文、判定版本、模型配置和指南/工具哈希。最多 200 用例、每例 20 步、两方案；单队列执行，重启将未结束任务标为 interrupted，用原快照手动重跑。不要增加后端 worker。
12. 新提示词组合至少完成一个成功执行的评测用例才能启用；这不是质量门槛证明。产品启用需要独立调用与原因，并校验 expected_active 防止覆盖队友操作。既有启用组合可回滚。
13. 评测结果不保存 reasoning_content / thinking 或原始 SDK 会话；SDK 恢复所需 transcript 仅在隔离私有运行目录（目录0700、文件0600）保存，不进入 API、结果导出或静态预览。理解字段是显式任务标签；缺失时必须待确认，不从最终答案猜隐藏过程。规则和语义判定分别保留证据，复核不覆盖系统结论。

## 部署配置与数据

完整步骤见部署手册。新部署将 `deploy/compose.env.example` 复制成忽略的 `.env.compose`；后续统一使用 `docker compose --env-file .env.compose ...`。

- `API_CONFIG_PATH`：宿主机模型 JSON 文件路径；Compose secret 挂载至 `/run/secrets/model_api`。
- `API_CONFIG_FILE`：后端读取配置的路径；本地 Python 在 `.env` 中设置，容器内由 `compose.yml` 设置。它与宿主机的 `API_CONFIG_PATH` 不同。
- `WEB_PORT`：宿主机前端端口，默认 8780。改变它时同步浏览器地址对应的 `ALLOWED_ORIGINS`。
- `COOKIE_SECURE`：浏览器通过 HTTPS 访问时设为 `true`；本地或 SSH 隧道的 HTTP 访问保持 `false`。
- 问答执行层固定 `claude-sdk`；SDK 失败明确报错，不自动回退。旧 `AGENT_RUNTIME` 环境变量不影响执行层。
- `AGENT_SDK_AUTO_COMPACT` / `AGENT_SDK_COMPACT_PCT`：默认 true / 60，通过已锁定 CLI 的环境变量提前自动压缩；不是保证无损或精确 token 输入预算。关闭自动压缩须自行控制窗口。
- `AGENT_SDK_SESSION_TTL_SECONDS` / `AGENT_SDK_MAX_SESSIONS`：默认闲置7天 / 每用户30个SDK会话；后续访问时清理，不是定时删除服务。管理记忆立即撤销并清理该用户SDK会话。
- `AGENT_SDK_CONTEXT_USAGE`：默认 false，开启后限时尝试SDK上下文统计；第三方接口不支持时显示unknown，不填0。
- `AGENT_SDK_BASE_URL`：SDK 入口，DeepSeek 官方为 https://api.deepseek.com/anthropic。第三方模型代理需要操作者提供真实兼容地址，不猜测路径。
- `TEST_ACCOUNT_PASSWORD`：私有统一测试密码，仅作用于 test1 到 test10；为空时不创建或重设测试账号，不删除已有账号。登录字段必须传字符串，保留前导零。
- `COMPOSE_PROJECT_NAME`：固定一个部署项目名，并在启动、日志、更新及备份时使用同一配置。更换名字会指向另一套卷和账号。
- `memory_data`：包含数据库、账号哈希、profiles 和首次密码；重建应用容器保留卷。

保持后端单 worker、单实例：登录和本轮运行状态在进程内，SQLite 保存长期记忆，SDK transcript及提交标记保存在原运行卷。删除/纠正/设置变更、过期、提示词/工具/指南/模型或压缩配置变更使旧SDK恢复失效；自动摘要增加revision后提交新值，不得每轮无条件清会话。当前不能直接增加 Uvicorn worker 或横向扩容后端。

前端默认绑定宿主机 `127.0.0.1`，后端不发布宿主机端口。服务器可经 SSH 隧道预览；公网域名通过同机 HTTPS 网关转发到前端。不要为了外网访问直接暴露后端或停掉无关服务。

后端镜像以 `appuser`（UID 10001）运行。文件来源的 Compose secret 使用绑定挂载，不能假定文件权限会自动变成可读；在目标机器执行手册中的容器读取权限检查，再处理宿主机所有权或 UID 映射。

保留已有 API 配置、账号和运行卷。`down -v`、删除运行文件、覆盖数据库和 `docker system prune --volumes` 不属于普通代码更新；仅在任务明确要求删除相应数据时执行。密钥、密码、Cookie 和用户会话不进入 Git、Issue、公开日志或静态预览。

## 验证和汇报

修改业务代码后，运行后端测试；修改前端或预览时，检查 JS 语法并验证相关 UI；修改部署文档时，检查涉及的命令和 Compose 配置。常用检查：

```sh
python -m pytest -q
find frontend -type f \( -name '*.js' -o -name '*.mjs' \) -exec node --check {} \;
node --test tests/*.cjs
python3 scripts/build_preview.py
python3 scripts/check_publish.py
docker compose --env-file .env.compose config --quiet
```

测试需要先安装 `requirements-lock.txt` 和 `requirements-dev.txt`；FakeModel 测试不需要 API Key。Node 只用于 JavaScript 检查，不是正式应用的运行依赖。

`/health` 返回 200 只证明后端能响应；`model.configured=true` 只证明配置可解析，不证明模型 Key、余额或模型名可用。真实模型、摘要、解决后退出回访和重启后的持久化按手册分别验收。

交付时报告部署机器/访问地址、Git SHA、Compose 项目名、检查结果及尚未验证的能力。缺少模型凭据时明确写“已启动，真实模型未验收”；只有静态 Pages 时明确写“静态交互预览”。不要把容器启动、静态模拟或测试模型通过写成真实服务全部验收完成。
