# LifeOS · 苟活

固定指南问答、长期会话摘要和首页问题回访。Python / FastAPI 后端保留身份、指南校验和记忆管理；问答统一通过 Claude Agent SDK（内含 Claude Code CLI）调度，仍使用 DeepSeek；SDK 管理连续会话与普通历史压缩。正式页面采用团队最新交付的 Horizon 前端；用 Docker Compose 启动前后端，不依赖 Dify。

用户提问后，Agent 搜索并完整读取指南，后端校验来源后展示答复。每轮自动生成摘要，记录明确的用户状态、寻求过的指南和问题进展。首页先询问上次的问题解决了没有、是否需要继续咨询；用户提交问题后才展示指南正文。

长期记忆按主题展示，可展开查看相关原话和来源记录，删除单条来源或整个主题。问答按相关性找回旧记忆，并控制本轮记忆的估算 token 预算；同主题达到阈值后在后台整理带来源的原话摘录，失败时仍可使用保留的来源。SDK 的聊天历史压缩与这套长期记忆管理独立。数据、删除和配置边界见[长期记忆管理](docs/长期记忆管理.md)。

**交给 Agent 拉取、调试或部署时，请先读 [AGENTS.md](AGENTS.md)，再按 [Agent 部署与验收手册](docs/Agent部署与验收.md) 执行。** 手册提供固定部署配置、服务器访问方式、分层验收、备份和更新流程。可以直接复制手册末尾的任务说明给团队 Agent。

## 正式前端与接入范围

`frontend/index.html` 是唯一产品入口，以团队 [BMBWaveforms/LifeOS 最新交付](https://github.com/BMBWaveforms/LifeOS/tree/b205c20aa81d37c304bd2640a597b630240c3756/frontend/horizon)（`b205c20`）为准。Horizon 模块与素材已提升到根目录，旧产品页面和旧模拟适配层移除；`/workbench.html` 保留为内部评测工具。

产品采用视频场景首页、对话侧栏、只读理解面板、产品内指南阅读及分享卡片。真实问答继续由本仓库 SDK 执行并校验指南。记忆自动整理，默认按主题展示，可展开来源并删除单条或整个主题。升级后产品账号统一启用自动记忆，原账号、来源和数据库保留，旧关闭状态会迁移并使旧 SDK 恢复状态失效；产品不再提供开关或手动纠正。测试会话仍可模拟关闭与纠正，且不影响产品数据。

真实对话历史保存在当前浏览器的账号隔离会话存储，可在当前浏览器内继续；没有跨设备历史列表 API。真实回复目前仍一次性返回 JSON，页面动画不代表服务端流式输出。接入与验收边界见[前端接入与验收](docs/前端接入与验收.md)。

## 团队预览与真实调试

| 方式 | 入口 | 能体验什么 |
|---|---|---|
| 在线静态预览 | [GitHub Pages](https://shuaishuaisylas.github.io/LifeOS/) | Horizon 页面、虚构对话、固定指南与演示记忆 |
| 完整应用 | 在自己电脑启动 Docker，访问 `http://localhost:8780` | 真实模型问答、自动模型摘要、SQLite 长期记忆与回访 |
| 架构与流程 | [团队讲解材料](docs/团队讲解/苟活项目架构与流程说明.md) | 整体架构、四张图、十分钟讲解顺序和常见问题 |
| 评测工作台 | 完整应用地址下 `/workbench.html` | 七个环节的提示词独立测试、整体交互/批量 A/B、证据与人工复核、提示词版本和产品启用；需登录 |

在线预览不连接模型或 Python 后端，演示记录保存在当前浏览器，不用于验证模型质量或后端权限。正式前端通过同源 `/api` 使用后端登录 Cookie；静态 Pages 没有真实 API。Pages 发布状态见 [Actions](https://github.com/shuaishuaisylas/LifeOS/actions)。完整联调见 [团队调试与预览](docs/团队调试与预览.md)。

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

将 `.env` 的 `API_CONFIG_FILE` 改成自己模型配置文件的绝对路径。所有启动方式统一使用 `claude-sdk`；SDK 通过 Anthropic 兼容入口调用 DeepSeek，摘要、首页回访和评测判定也使用独立无工具的 SDK 临时任务。Python 原生问答执行层和切换入口已移除；旧 `AGENT_RUNTIME` 环境变量不再改变执行层。再运行：

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

完整应用登录后访问 `/workbench.html`。在“评测集”填写输入、步骤和预期，可批量运行同一版本，用两份提示词组合做 A/B，均通过SDK执行。结果展示五个环节与独立整体判定，支持人工复核和 JSON / CSV 导出。“提示词管理”可编辑模块、保存版本、对比差异、创建组合；测试与产品启用分开。七个初始虚构用例用于熟悉工具，不代表通过的质量基准。具体限制、API 和操作顺序见 [评测工作台手册](docs/评测工作台.md)。

## 文件在哪里维护

| 内容 | 位置 |
|---|---|
| FastAPI、工具调用循环、记忆及校验 | `backend/` |
| SDK 会话与压缩、指南工具、隔离测试记录 | `backend/executors.py`、`tools.py`、`workbench.py` |
| 唯一产品入口、固定情境与真实接口适配 | `frontend/index.html`、`app.mjs`、`landing-scenes.mjs`、`service.mjs` |
| 模块化提示词初始文档 | `prompts/modules/*.md`（七模块）；部署后版本在工作台维护，可导出/导入独立文档 |
| 评测集、批量判定与提示词管理 | `backend/prompt_tests.py`、`evaluation.py`、`prompts.py`；[工作台手册](docs/评测工作台.md) |
| 两个只读工具定义 | `prompts/tools.json` |
| 指南能力维护约束 | `skills/guide-only.md` |
| 固定指南全文、来源与许可证 | `data/` |
| Docker、Nginx 配置 | `compose.yml`、`deploy/` |
| 独立模拟服务与静态预览构建 | `frontend/service.mjs` 的 DemoService、`scripts/build_preview.py` |
| 团队调试、架构、部署与验收说明 | `docs/` |
| 自动测试与 Pages 发布 | `.github/workflows/` |

提示词从独立模块文档初始化，工作台保存不可变版本和组合；每次请求固定产品启用组合。Docker 只读挂载 `prompts/`；已有部署通过工作台导入/编辑、测试并单独启用。`skills/guide-only.md` 是维护约束，当前没有作为运行时 Skill 自动加载。业务 harness 保留上下文、来源和记忆版本校验；工具循环、连续历史及普通压缩交给SDK。部署和测试方式见 [执行层与测试台](docs/执行层与测试台.md)。

## 当前范围

当前是单机 Demo：一个问答 Agent、两个只读工具，另有摘要和回访两个模型任务。指南使用 2026-10-12 固定快照，共 687 条，检索采用中文双字片段匹配和标题加权。

团队测试支持 `test1` 到 `test10`，原 `alice` / `bob` 仍保留。测试密码通过私有配置提供；尚未实现注册、找回密码、SSO、多实例状态协调或正式用户上线验收。后端保持一个 worker。公网完整服务需要 HTTPS、正式账号和运维配置，不能直接把静态 Pages 预览当成 Python 服务。

旧 Dify 版本和原始源码交付包仍保存在项目所有者电脑的 `保留版本/Dify-v0.2/`，不包含在这个仓库中。本机的密钥、密码、SQLite、个人记忆和历史运行 JSON 不提交。已有验证及边界见 [验收记录](docs/验收记录.md)。

团队页面保留随附[视频素材来源](frontend/assets/media-sources.json)。指南内容按 CC BY 4.0 保留署名；见 [来源说明](data/ATTRIBUTION.txt) 和 [指南许可证](data/GUIDE-LICENSE.txt)。

会话按用户隔离，只有通过来源及记忆版本校验的轮次可恢复。默认提前至 SDK 计算窗口的 60% 尝试压缩，闲置 7 天或超过每用户 30 个会话时在后续访问清理；重要事实、问题状态仍在 SQLite，压缩摘要不作为唯一依据。产品可以从当前浏览器的历史侧栏继续聊天；服务端暂未提供跨设备历史列表。配置与边界见 [SDK 执行层与测试台](docs/执行层与测试台.md)。Mac 系统应用目前仅完成[接入调研](docs/Mac备忘录与提醒事项接入调研.md)，尚未连接私人数据。
