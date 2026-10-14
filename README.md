# LifeOS · 苟活

固定指南问答、长期会话摘要和首页问题回访。Python / FastAPI 后端保留身份、指南校验和记忆管理；问答执行层可选择 Python 自实现或 Claude Agent SDK，两种都使用 DeepSeek。HTML/CSS/JavaScript 前端独立运行；用 Docker Compose 启动前后端，不依赖 Dify。

用户提问后，Agent 搜索并完整读取指南，后端校验来源后展示答复。开启记忆时，每轮自动生成摘要，记录明确的用户状态、寻求过的指南和问题进展。首页先询问上次的问题解决了没有、是否需要继续咨询；用户提交问题后才展示指南正文。

**交给 Agent 拉取、调试或部署时，请先读 [AGENTS.md](AGENTS.md)，再按 [Agent 部署与验收手册](docs/Agent部署与验收.md) 执行。** 手册提供固定部署配置、服务器访问方式、分层验收、备份和更新流程。可以直接复制手册末尾的任务说明给团队 Agent。

## 团队预览与真实调试

| 方式 | 入口 | 能体验什么 |
|---|---|---|
| 在线静态预览 | [GitHub Pages](https://shuaishuaisylas.github.io/LifeOS/) | 虚构账号、固定指南示例、浏览器模拟记忆与回访交互 |
| 完整应用 | 在自己电脑启动 Docker，访问 `http://localhost:8780` | 真实模型问答、自动模型摘要、SQLite 长期记忆与回访 |
| 架构与流程 | [团队讲解材料](docs/团队讲解/苟活项目架构与流程说明.md) | 整体架构、四张图、十分钟讲解顺序和常见问题 |
| 执行层测试台 | 完整应用地址下 `/workbench.html` | 切换执行层、连续测试、同输入对比、工具记录和记忆变化；需登录 |

在线预览不连接模型或 Python 后端，记忆仅保存在当前浏览器，不用于验证模型质量或后端权限。Pages 发布状态见 [Actions](https://github.com/shuaishuaisylas/LifeOS/actions)。完整联调见 [团队调试与预览](docs/团队调试与预览.md)。

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

访问 `http://localhost:8780`。首次启动会为 `alice` 和 `bob` 生成独立的随机密码，查看：

```sh
docker compose --env-file .env.compose exec backend python -c 'from pathlib import Path; print(Path("/app/runtime/login.json").read_text())'
```

启用自动摘要后，尝试“工作时被手机通知打断，怎么改善？”，查看指南来源、长期摘要和首页回访；点击已解决后，该问题退出回访。两个账号数据隔离。

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

将 `.env` 的 `API_CONFIG_FILE` 改成自己模型配置文件的绝对路径，再运行：

```sh
.venv/bin/python scripts/run_local.py
```

前端在 8780，后端在 8781。macOS 也可双击 `启动独立版.command`。关闭终端或 Ctrl+C 停止本次启动的进程；请不要同时在相同端口启动 Docker 版。

测试不需要模型 API Key：

```sh
.venv/bin/python -m pytest -q
```

CI 会运行后端测试、JavaScript 语法检查、静态预览构建、提交文件检查与 Compose 配置检查。CI 使用 FakeModel 校验业务约束，不代表真实模型效果评测。

## 文件在哪里维护

| 内容 | 位置 |
|---|---|
| FastAPI、工具调用循环、记忆及校验 | `backend/` |
| 可替换执行层、共用工具、隔离测试记录 | `backend/executors.py`、`tools.py`、`workbench.py` |
| 正式前端页面与交互 | `frontend/` |
| 问答、摘要、回访提示词 | `prompts/chat.md`、`summary.md`、`home.md` |
| 两个只读工具定义 | `prompts/tools.json` |
| 指南能力维护约束 | `skills/guide-only.md` |
| 固定指南全文、来源与许可证 | `data/` |
| Docker、Nginx 配置 | `compose.yml`、`deploy/` |
| 静态预览适配层及构建 | `preview/adapter.js`、`scripts/build_preview.py` |
| 团队调试、架构、部署与验收说明 | `docs/` |
| 自动测试与 Pages 发布 | `.github/workflows/` |

提示词每轮从独立文件读取；Docker 只读挂载 `prompts/`，修改后对后续调用生效。`skills/guide-only.md` 是维护约束，当前没有作为运行时 Skill 自动加载。业务 harness 保留上下文、来源和记忆版本校验；工具循环交给选定执行层。切换、部署和测试方式见 [执行层与测试台](docs/执行层与测试台.md)。

## 当前范围

当前是单机 Demo：一个问答 Agent、两个只读工具，另有摘要和回访两个模型任务。指南使用 2026-10-12 固定快照，共 687 条，检索采用中文双字片段匹配和标题加权。

账号为两个预置体验账号；尚未实现注册、找回密码、SSO、多实例状态协调或正式用户上线验收。后端保持一个 worker。公网完整服务需要 HTTPS、正式账号和运维配置，不能直接把静态 Pages 预览当成 Python 服务。

旧 Dify 版本和原始源码交付包仍保存在项目所有者电脑的 `保留版本/Dify-v0.2/`，不包含在这个仓库中。本机的密钥、密码、SQLite、个人记忆和历史运行 JSON 不提交。已有验证及边界见 [验收记录](docs/验收记录.md)。

指南内容按 CC BY 4.0 保留署名；见 [来源说明](data/ATTRIBUTION.txt) 和 [指南许可证](data/GUIDE-LICENSE.txt)。
