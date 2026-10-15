# LifeOS · 苟活

固定指南问答、长期会话摘要和首页问题回访。Python / FastAPI 后端保留身份、指南校验和记忆管理；问答默认通过 Claude Agent SDK（内含 Claude Code CLI）调度，仍使用 DeepSeek；可显式切换 Python 自实现执行层。正式页面采用合伙人的 LifeOS 前端；用 Docker Compose 启动前后端，不依赖 Dify。

用户提问后，Agent 搜索并完整读取指南，后端校验来源后展示答复。开启记忆时，每轮自动生成摘要，记录明确的用户状态、寻求过的指南和问题进展。首页先询问上次的问题解决了没有、是否需要继续咨询；用户提交问题后才展示指南正文。

**交给 Agent 拉取、调试或部署时，请先读 [AGENTS.md](AGENTS.md)，再按 [Agent 部署与验收手册](docs/Agent部署与验收.md) 执行。** 手册提供固定部署配置、服务器访问方式、分层验收、备份和更新流程。可以直接复制手册末尾的任务说明给团队 Agent。

## 正式前端与接入范围

`frontend/index.html` 是唯一产品入口，采用 [lrj813/LifeOS](https://github.com/lrj813/LifeOS/tree/7d89e4b18bfaa27d49235826d740e50e200b1aff/frontend) 的正式页面与素材（来源版本 `7d89e4b18bfaa27d49235826d740e50e200b1aff`），并对接本仓库后端。此前的问答测试页不再作为产品首页；`/workbench.html` 继续保留为内部测试与评测工具。

首版路径是“固定情境入口 → 真实问答 → 指南详情 → 自动摘要 → 问题回访”。情境卡片是固定入口；用户提交后由后端调用模型并校验指南来源。个人档案可开启或关闭自动摘要；新账号默认关闭。开启后，每轮返回摘要保存结果，首页显示仍需跟进的问题。聊天记录仅保留在当前页面，刷新后不恢复完整历史，已保存的长期摘要由后端保留。接口、部署边界和本轮验收见 [前端接入与验收](docs/前端接入与验收.md)。

## 团队预览与真实调试

| 方式 | 入口 | 能体验什么 |
|---|---|---|
| 在线静态预览 | [GitHub Pages](https://shuaishuaisylas.github.io/LifeOS/) | 合伙人页面、虚构账号、固定指南示例与本页模拟摘要/回访 |
| 完整应用 | 在自己电脑启动 Docker，访问 `http://localhost:8780` | 真实模型问答、自动模型摘要、SQLite 长期记忆与回访 |
| 架构与流程 | [团队讲解材料](docs/团队讲解/苟活项目架构与流程说明.md) | 整体架构、四张图、十分钟讲解顺序和常见问题 |
| 评测工作台 | 完整应用地址下 `/workbench.html` | 评测集、批量 A/B、五环节及整体评测、系统判定与人工复核、提示词版本和产品启用；需登录 |

在线预览不连接模型或 Python 后端，模拟记录仅保留在当前页面，刷新后重置，不用于验证模型质量或后端权限。正式前端通过同源 `/api` 使用后端登录 Cookie；静态 Pages 没有真实 API。Pages 发布状态见 [Actions](https://github.com/shuaishuaisylas/LifeOS/actions)。完整联调见 [团队调试与预览](docs/团队调试与预览.md)。

## 用 Docker 启动完整应用

先克隆仓库，然后在项目目录创建自己的模型配置：

```sh
git clone https://github.com/shuaishuaisylas/LifeOS.git
cd LifeOS
cp config/model-api.example.json api.json
cp deploy/compose.env.example .env.compose
```

编辑 `api.json`，填入自己的 API Key、接口地址和可用模型名。不要提交该文件。然后启动：

```sh
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose ps
```

访问 `http://localhost:8780`。团队测试账号为 `test1` 到 `test10`；在私有 `.env.compose` 设置 `TEST_ACCOUNT_PASSWORD` 后，启动时自动补齐十个账号并同步这些测试账号的密码。原有账号、身份和数据保留；未配置测试密码时保持已有账号。部署者可查看私有凭据文件：

```sh
docker compose --env-file .env.compose exec backend python -c 'from pathlib import Path; print(Path("/app/runtime/login.json").read_text())'
```

启用自动摘要后，尝试“工作时被手机通知打断，怎么改善？”，查看指南来源、长期摘要和首页回访；点击已解决后，该问题退出回访。各账号数据隔离。

如果 8780 已被占用，可用下面的替代启动命令：

```sh
WEB_PORT=8782 ALLOWED_ORIGINS=http://localhost:8782,http://127.0.0.1:8782 docker compose --env-file .env.compose up -d --build
```

SQLite、账号哈希和首次凭据保存在 `memory_data` 数据卷中。`docker compose --env-file .env.compose down` 保留它们；加 `-v` 会删除卷。模型凭据通过只读 secret 挂载，不进入前端或镜像。详细配置和备份方法见 [部署说明](docs/部署.md)。

每次操作沿用同一 `.env.compose` 和项目名；替代端口日常使用时应写入该文件。更新已有部署先确认原项目名，避免创建另一套卷。Linux 上还需按 Agent 手册验证 UID 10001 能读取挂载的模型文件；后端 healthy 不代表密钥文件可读。

## 本地开发

使用 Python 3.10 或以上；Docker 和 CI 使用 Python 3.12。已有 Python 3.9 虚拟环境请保留，另建 `.venv-sdk`；macOS 启动脚本会优先使用兼容环境。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-lock.txt -r requirements-dev.txt
cp .env.example .env
```

将 `.env` 的 `API_CONFIG_FILE` 改成自己模型配置文件的绝对路径。所有启动方式缺省都使用 `claude-sdk`；SDK 通过 Anthropic 兼容入口调用 DeepSeek，摘要和回访继续走原 Chat Completions 入口。需要原生执行层时显式设置 `AGENT_RUNTIME=native`。再运行：

```sh
.venv/bin/python scripts/run_local.py
```

前端在 8780，后端在 8781。macOS 也可双击 `启动独立版.command`。关闭终端或 Ctrl+C 停止本次启动的进程；请不要同时在相同端口启动 Docker 版。

测试不需要模型 API Key：

```sh
.venv/bin/python -m pytest -q
```

CI 会运行后端测试、产品/预览 JavaScript 语法检查与契约测试、静态预览构建、提交文件检查与 Compose 配置检查。CI 使用 FakeModel 校验业务约束，不代表真实模型效果评测。

## 评测工作台

完整应用登录后访问 `/workbench.html`。在“评测集”填写输入、步骤和预期，可批量运行同一版本，用两个执行层或两个提示词组合做 A/B。结果展示五个环节与独立整体判定，支持人工复核和 JSON / CSV 导出。“提示词管理”可编辑模块、保存版本、对比差异、创建组合；测试与产品启用分开。七个初始虚构用例用于熟悉工具，不代表通过的质量基准。具体限制、API 和操作顺序见 [评测工作台手册](docs/评测工作台.md)。

## 文件在哪里维护

| 内容 | 位置 |
|---|---|
| FastAPI、工具调用循环、记忆及校验 | `backend/` |
| 可替换执行层、共用工具、隔离测试记录 | `backend/executors.py`、`tools.py`、`workbench.py` |
| 唯一产品入口、固定情境与真实接口适配 | `frontend/index.html`、`app.js`、`scenes.js`、`services.js` |
| 模块化提示词初始文档 | `prompts/modules/*.md`（七模块）；部署后版本在工作台维护，可导出/导入独立文档 |
| 评测集、批量判定与提示词管理 | `backend/evaluation.py`、`prompts.py`；[工作台手册](docs/评测工作台.md) |
| 两个只读工具定义 | `prompts/tools.json` |
| 指南能力维护约束 | `skills/guide-only.md` |
| 固定指南全文、来源与许可证 | `data/` |
| Docker、Nginx 配置 | `compose.yml`、`deploy/` |
| 独立模拟服务与静态预览构建 | `preview/mock-service.js`、`adapter.js`、`styles.css`、`scripts/build_preview.py` |
| 团队调试、架构、部署与验收说明 | `docs/` |
| 自动测试与 Pages 发布 | `.github/workflows/` |

提示词从独立模块文档初始化，工作台保存不可变版本和组合；每次请求固定产品启用组合。Docker 只读挂载 `prompts/`；已有部署通过工作台导入/编辑、测试并单独启用。`skills/guide-only.md` 是维护约束，当前没有作为运行时 Skill 自动加载。业务 harness 保留上下文、来源和记忆版本校验；工具循环交给选定执行层。切换、部署和测试方式见 [执行层与测试台](docs/执行层与测试台.md)。

## 当前范围

当前是单机 Demo：一个问答 Agent、两个只读工具，另有摘要和回访两个模型任务。指南使用 2026-10-12 固定快照，共 687 条，检索采用中文双字片段匹配和标题加权。

团队测试支持 `test1` 到 `test10`，原 `alice` / `bob` 仍保留。测试密码通过私有配置提供；尚未实现注册、找回密码、SSO、多实例状态协调或正式用户上线验收。后端保持一个 worker。公网完整服务需要 HTTPS、正式账号和运维配置，不能直接把静态 Pages 预览当成 Python 服务。

旧 Dify 版本和原始源码交付包仍保存在项目所有者电脑的 `保留版本/Dify-v0.2/`，不包含在这个仓库中。本机的密钥、密码、SQLite、个人记忆和历史运行 JSON 不提交。已有验证及边界见 [验收记录](docs/验收记录.md)。

合作方页面保留随附素材和 Noto Serif SC 的 [字体许可](frontend/assets/fonts/OFL.txt)。指南内容按 CC BY 4.0 保留署名；见 [来源说明](data/ATTRIBUTION.txt) 和 [指南许可证](data/GUIDE-LICENSE.txt)。

## Horizon 候选前端与 Agent 交接

新版前端作为独立入口 `/horizon/` 交付，默认首页和内部工作台保留。后端 Agent 请从 [Horizon 交接索引](docs/handoff/horizon/README.md) 开始；功能差异、现有/建议协议、记忆策略冲突、验收与机器可读清单都在该目录。演示默认使用本地固定指南；真实模式复用同源 API，尚需完成服务端策略与真实模型验收。运行 `python3 scripts/frontend_server.py --port 8892` 后打开 `http://127.0.0.1:8892/horizon/`。
