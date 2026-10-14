# Agent 部署与验收手册

这份手册面向拉取 LifeOS 代码并替团队执行部署的 Agent。命令在仓库根目录执行，使用 Bash / zsh；Windows 可在 WSL2 中执行。首次部署、已有部署更新和静态预览分别处理。

仓库：`https://github.com/shuaishuaisylas/LifeOS`。先读取根目录 `AGENTS.md`。完整应用使用 Docker Compose，后端调用远程模型 API；服务器不需要安装模型权重或运行本地推理服务。

## 1. 先识别任务和已有环境

| 必需信息 | 如何使用 |
|---|---|
| 部署目标 | 当前电脑，或已授权的服务器 SSH 地址及目标目录 |
| 体验方式 | 完整 Docker 应用，或明确只看静态预览 |
| 模型配置 | 私有 JSON 文件路径；提供者支持的 HTTPS 地址、模型名和 API Key |
| 访问方式 | 本机 HTTP、SSH 隧道，或已有域名和 HTTPS 网关 |
| 已有部署 | Compose 项目名、端口、卷、配置文件和当前 Git SHA |

若目标服务器或模型配置还没提供，先检查源码、安装条件和测试。缺少真实参数时列出缺失值，不以假地址或示例 Key 代替。操作者可以通过私有文件配置 Key，只把文件路径交给 Agent。

在当前目标机器检查：

```sh
git --version
docker version
docker compose version
docker compose ls --all
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
```

`docker version` 应能连接 Docker daemon；只有客户端版本输出不够。已有应用或端口占用时选择空闲端口，保留原服务。服务器的 `localhost` 指服务器自身，不是团队成员电脑。

新目录拉取：

```sh
git clone https://github.com/shuaishuaisylas/LifeOS.git
cd LifeOS
git status --short --branch
git rev-parse HEAD
```

已有 checkout 先检查工作树、远端和部署记录；存在未提交修改时保留它们。普通部署不使用 `git reset --hard`、强制推送或删除目录来消除差异。

## 2. 配置一套完整部署

新部署统一使用 `.env.compose`，避免后续命令遗漏端口或指向另一套记忆卷。下列复制仅创建不存在的文件；已有配置保持原样。

```sh
if [ ! -e .env.compose ]; then
  cp deploy/compose.env.example .env.compose
fi
if [ ! -e api.json ]; then
  cp config/model-api.example.json api.json
fi
chmod 600 .env.compose api.json
```

操作者在私有 `api.json` 填写真实配置。字段结构见 `config/model-api.example.json`；其中 `YOUR_API_KEY` 只是占位值，示例模型名须与提供者当前支持的模型一致。仅通过 JSON 解析检查格式，不在公共日志打印整个文件。

`.env.compose` 的默认内容：

```dotenv
COMPOSE_PROJECT_NAME=lifeos-team
API_CONFIG_PATH=./api.json
WEB_PORT=8780
ALLOWED_ORIGINS=http://localhost:8780,http://127.0.0.1:8780
COOKIE_SECURE=false
AGENT_RUNTIME=claude-sdk
AGENT_SDK_BASE_URL=https://api.deepseek.com/anthropic
TEST_ACCOUNT_PASSWORD=
```

| 参数 | 位置与作用 | 常见误解 |
|---|---|---|
| `API_CONFIG_PATH` | Compose 读取的宿主机 JSON 路径，默认示例为仓库内私有 `api.json` | 它不是容器内的路径 |
| `API_CONFIG_FILE` | 容器内固定为 `/run/secrets/model_api`；本地 Python 在 `.env` 中设置 | 本地 `.env` 的路径不会自动适配容器 |
| `WEB_PORT` | 宿主机前端端口，容器前端仍监听 80 | 它不改变后端内部 8781 |
| `ALLOWED_ORIGINS` | 浏览器地址的完整 origin，含协议及非默认端口，不带路径或末尾斜杠；多个用逗号分隔且不加空格 | 填服务器 IP 不等于允许本机隧道地址 |
| `COOKIE_SECURE` | 浏览器使用 HTTPS 时为 true；本机/隧道 HTTP 为 false | HTTP 开启 true 会导致登录 Cookie 不发送 |
| `COMPOSE_PROJECT_NAME` | 识别容器和数据卷，部署后保持固定 | 改名字会创建另一套账号和记忆卷 |
| `AGENT_RUNTIME` | 产品默认 native / claude-sdk | 测试页切换不改变产品默认；失败不自动回退 |
| `AGENT_SDK_BASE_URL` | SDK 的 Anthropic 兼容入口 | 与 api.json 的 Chat Completions base_url 不同 |
| `TEST_ACCOUNT_PASSWORD` | 私有统一测试密码，启动时补齐 test1 到 test10 | 仅更新这些测试账号的密码；原账号及数据保留；密码不提交到 Git |

`api.json` 中的 `base_url` 必须是无账号密码、查询参数和片段的 HTTPS 地址；客户端在末尾追加 `/chat/completions`。Docker 部署把模型名和 Key 放在挂载 JSON 中；当前 Compose 没有把宿主机的 `MODEL_API_KEY`、`MODEL_NAME` 等变量直接传入容器。

Compose 会优先使用当前 shell 的同名环境变量，其次才是 `--env-file`；发现配置值异常时检查这一来源。只检查有关参数，不整体转储环境中的敏感值。[Docker 环境变量说明](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)

项目名影响容器、网络和卷的归属。新部署可以使用示例 `lifeos-team`；更新已有部署时必须沿用原项目名。[Docker 项目名说明](https://docs.docker.com/compose/how-tos/project-name/)

## 3. 构建并启动

模型 JSON 已填写后，在仓库根目录执行：

```sh
docker compose --env-file .env.compose config --quiet
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose ps
```

预期两个服务：`backend` 状态为 running / healthy，`frontend` 为 running。前端默认发布 `127.0.0.1:8780 → 80`；后端仅在 Compose 内部监听 8781。保持后端一实例、一 worker。

随后验证当前后端用户能读取 secret，命令不输出文件内容：

```sh
docker compose --env-file .env.compose exec -T backend python -c 'import os; assert os.access("/run/secrets/model_api", os.R_OK), "Model secret is not readable by the backend user"; print("Model secret is readable")'
```

后端 UID 为 10001。Linux 文件所有权与宿主机用户不同，`chmod 600 api.json` 后可能导致容器无法读取。文件来源的 secret 是 bind mount，Compose 的 secret `uid/gid/mode` 配置不会自动修复这一问题。[Docker secret 权限说明](https://docs.docker.com/reference/compose-file/services/#secrets)

仅当上述检查失败，并确认使用普通 rootful Docker、没有 user namespace remap 时，可在已授权的目标 Linux 主机创建后端可读的私有副本：

```sh
docker info --format '{{json .SecurityOptions}}'
sudo install -d -m 700 -o 10001 -g 10001 /var/lib/lifeos-private
sudo install -m 600 -o 10001 -g 10001 api.json /var/lib/lifeos-private/model-api.json
```

再将 `.env.compose` 的 `API_CONFIG_PATH` 改为 `/var/lib/lifeos-private/model-api.json`，重新创建后端并重复读取检查。rootless / userns 环境应按实际宿主机 UID 映射或既有 secret 制度配置权限，不照搬 UID，也不改成全局可写或把后端改为 root。之后更新 Key 要同步到这个实际挂载副本。

若宿主机 8780 已占用，将 `.env.compose` 改为：

```dotenv
WEB_PORT=8782
ALLOWED_ORIGINS=http://localhost:8782,http://127.0.0.1:8782
```

保留其他参数，再执行同一组 `up -d --build` 和 `ps`。以下示例按默认 8780；换端口后同步修改访问地址。不要把作者本机的 8782 或容器名当成所有部署的固定值。

## 4. 分层验收，不跳过真实链路

### 4.1 容器、页面与 API

```sh
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8780/ -o /dev/null
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8780/health
curl --silent --show-error --max-time 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8780/api/memories
```

页面应返回 200；健康 JSON 应包含 `status: ok`、`backend: python-direct-api`、当前 687 个条目和内容版本。未经登录的 `/api/memories` 应为 401。这三步同时确认前端能访问、转发到正确后端，以及私有接口需要登录。

`model.configured=true` 仅说明配置可解析。占位 Key 或余额不足时也可能为 true，因此不能在这里报告真实问答成功。

### 4.2 登录及真实模型链路

团队测试账号 test1 到 test10 使用私有配置 TEST_ACCOUNT_PASSWORD；启动时创建或同步这些账号，密码字段必须传字符串以保留前导零。旧 alice / bob 的密码仍是部署独立生成的值。GitHub Pages 使用自己的虚构预览账号。可将首次登录文件复制到忽略的私有目录，让操作者安全读取：

```sh
mkdir -p .private-backups
chmod 700 .private-backups
docker compose --env-file .env.compose cp backend:/app/runtime/login.json .private-backups/login.json
chmod 600 .private-backups/login.json
```

此文件可能因操作者之前移走而不存在；已正常运行时不要删除 `auth.json` 来重新生成密码。向操作者取得既有凭据或按独立的账号维护任务处理。

在新测试部署或明确用于测试的账号中走完整链路，不清空已有用户数据：

| 步骤 | 用户操作或 API | 通过条件 |
|---|---|---|
| 登录 | `POST /api/login`，JSON 为 `{username,password}` | 200，收到会话 Cookie；后续请求使用同一 Cookie |
| 开启记忆 | `POST /api/memory-action`，`{action:"settings",enabled:true}` | 记忆设置开启 |
| 提问 | `POST /api/run`，`{mode:"chat",query:"我工作时被手机通知打断，怎么办？"}` | 实际模型回答，来源条目有效，`summary.saved=true`，返回摘要 ID |
| 读取摘要 | `GET /api/memories` | 本轮摘要存在，包含问题、状态、指南记录和进展 |
| 开始新会话 | 页面点击新会话，再刷新回访 | 长期摘要仍存在，首页询问未解决问题，不出现指南正文 |
| 继续咨询 | 点击继续问相关指南，编辑并提交 | 点击仅预填问题；提交后才检索并展示指南 |
| 反馈已解决 | 点击已经解决；API 调用需带当前 `followup_memory_id` | 新摘要确认 resolved，经历保留，首页不再回访该问题 |
| 关闭记忆 | 关闭开关后再提问 | 本轮不保存摘要，不用旧长期记忆进行个性化 |
| 用户隔离 | 退出并用另一个体验账号登录 | 只看到该账号自己的记录 |
| 持久化 | 重启本项目后端后重新登录 | 会话 Cookie 需重新登录；SQLite 的摘要仍存在 |

API 字段和异常状态见 [架构与接口](架构与接口.md)。记录来源 ID、保存状态、回访状态及 HTTP 码即可，不将密码、Cookie 或完整用户会话贴进共享记录。若使用浏览器验证，也确认页面明确标注 Python 独立版，而非静态预览。

问答包含多轮工具调用，答复返回前还会整理摘要。自动调用 `/api/run` 时使用足够的客户端超时，例如 300 秒；180 秒是问答 Agent 的循环预算，不能当作含摘要和排队的整个 HTTP 请求上限。

### 4.3 验收结果怎样表述

- 只有页面、容器和健康接口通过：报告“服务启动及路由通过，真实模型未验收”。
- FakeModel 自动测试通过：报告“后端业务约束测试通过”，不代表真实模型质量通过。
- 已用真实模型完成上述流程：逐项列出实际验证的功能；失败项保留状态和原因。
- 没有 API Key 或无法登录时，说明缺失环节，继续完成不依赖它的检查。

## 5. 服务器访问

代码在服务器上构建镜像；不要复制本机 `.venv`、Docker 运行数据或个人数据库作为部署包。将模型凭据另行传到目标私有文件，并设置 `.env.compose` 中的实际路径。

### 临时团队体验：SSH 隧道

保持服务器前端绑定 `127.0.0.1:8780`。若团队电脑的 8780 已占用，可在服务器的 `.env.compose` 中追加允许浏览器使用的 origin：

```dotenv
ALLOWED_ORIGINS=http://localhost:8780,http://127.0.0.1:8780,http://localhost:8870,http://127.0.0.1:8870
COOKIE_SECURE=false
```

重新 `up -d --build` 使后端配置生效，然后在团队电脑建立隧道，替换 `USER@SERVER` 为实际授权的 SSH 目标：

```sh
ssh -N -L 8870:127.0.0.1:8780 USER@SERVER
```

浏览器访问 `http://localhost:8870`。8870 是客户端端口，8780 是服务器端口；两者不必相同。浏览器 origin 对应 8870，因此需要上述允许来源。SSH 目标尚未提供时，此处只准备步骤，不执行示例主机。

### 域名访问：已有 HTTPS 网关

同一服务器上的网关将正式域名转发到 `http://127.0.0.1:8780`，含根路径、`/api/` 和 `/health`。使用机器已有的证书与站点配置，不假定证书路径，也不覆盖其他站点。

例如浏览器实际地址为 `https://lifeos.example.com`，替换为真实域名后设置：

```dotenv
ALLOWED_ORIGINS=https://lifeos.example.com
COOKIE_SECURE=true
```

重新创建应用容器，确认 HTTPS 登录 Cookie 与 API 均正常。网关上游读取超时匹配项目内置 Nginx 的 300 秒配置，保留 Host 转发。若网关运行在另一个容器中，它的 `127.0.0.1` 不是宿主机，应按目标网络设计确定上游，不能照抄此地址。

配置统一测试密码后提供十个团队测试账号，并保留已有体验账号，适合受控团队调试。对正式用户开放仍需账号、并发、数据和运维方案；部署任务不自动等于新增注册、SSO 或多实例架构。

## 6. 日常更新、备份和回退

### 更新前固定部署身份

后续所有命令继续使用原 `.env.compose` 和项目名。修改 Key JSON 后通常后续调用会读取新值；若用原子替换的方式换了文件，重新创建后端以刷新 secret 挂载。修改端口、来源或 Cookie 配置后重新创建容器。

更新 Python/前端代码时重新构建；`prompts/` 为只读绑定挂载。七个模块文档只用于首次初始化，已有部署通过工作台导入或编辑生成新版本，测试后独立启用；不会因文件编辑覆盖 prompts.sqlite 中的启用组合。数据库和账号卷保持原样。

### 数据备份

需要保留现有记忆时，在操作窗口内停止本项目后端，复制完整运行目录，再恢复后端；这会短暂中断服务并使旧登录会话失效。下面的私有备份目录不提交：

```sh
TASK_BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p .private-backups
chmod 700 .private-backups
docker compose --env-file .env.compose stop backend
docker compose --env-file .env.compose cp backend:/app/runtime ".private-backups/$TASK_BACKUP_ID"
docker compose --env-file .env.compose start backend
```

确认备份目录包含 `memory.sqlite`、`auth.json` 和 `profiles.json`；`login.json` 若仍存在也包含其中。复制失败时先恢复服务，再处理备份故障。备份含私有信息，需要移至团队指定的私有备份存储。[Docker Compose 文件复制说明](https://docs.docker.com/reference/cli/docker/compose/cp/)

恢复是独立的数据操作：停止正确部署的后端，再将选定备份内容恢复到同一个 `memory_data` 卷，保留账号哈希和 profiles 的一致性。恢复后文件应能由镜像中的 `appuser` 写入；启动并验证登录与已有摘要。仅覆盖数据库、切换项目名或重建账号不能视为完整恢复。

### 更新与代码回退

工作树干净、当前部署已验证时，记录成功版本，然后更新：

```sh
mkdir -p .private-backups
git rev-parse HEAD > .private-backups/last-good-revision
git pull --ff-only origin main
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose ps
```

完成第 4 节验收后，再将本次版本记为成功部署。回退到记录的成功版本时，保留已有数据卷和私有配置：

```sh
TASK_GOOD_SHA="$(cat .private-backups/last-good-revision)"
git switch --detach "$TASK_GOOD_SHA"
docker compose --env-file .env.compose up -d --build
```

回退前仍需工作树干净，结束时注明当前处于 detached HEAD。当前项目没有版本化数据库迁移；代码回退不能保证未来 schema 变更兼容，涉及数据结构变化时应按该版本的恢复方案处理。

普通重建不使用 `down -v` 或删除卷；这些操作会丢失长期记忆及账号。更换 Compose 项目名时，旧数据可能仍在旧卷中，应先核对部署身份。

## 7. 故障定位顺序

先查看对应项目的服务状态和脱敏日志：

```sh
docker compose --env-file .env.compose ps
docker compose --env-file .env.compose logs --tail 100 backend frontend
```

| 现象 | 先检查 |
|---|---|
| Docker daemon 无法连接 | 目标机器 Docker 是否启动、当前用户是否有执行权限 |
| 构建失败 | Dockerfile、依赖下载和目标机器网络；按实际错误处理，不先改业务代码 |
| secret 文件不存在 | `API_CONFIG_PATH` 指向宿主机现存文件；保留已有配置，不拿占位 Key 冒充完成 |
| 页面可打开但 `/health` 为 502 | 后端是否 healthy、前端转发是否指向 `backend:8781` |
| `model.configured=false` | 先检查后端用户能否读取 secret，再检查 JSON 格式、Key 字段和 HTTPS base_url；不打印 Key |
| 模型 HTTP 401/403 | Key 或提供者鉴权；健康接口 configured 并不能排除此故障 |
| 模型 HTTP 400 | 实际可用模型名及兼容参数；改配置前核对提供者的当前接口 |
| POST 请求 403 | 浏览器实际 origin 与 `ALLOWED_ORIGINS` 是否匹配，含隧道端口 |
| 登录成功后立即变成未登录 | HTTP 下是否误开 Secure Cookie；是否刚重启后端导致会话失效 |
| 密码错误 | 当前部署的首次密码/既有凭据，不能用静态 preview 口令或另一部署的密码 |
| 重启后记忆看似消失 | Compose 项目名和卷是否改变，是否误执行了删卷命令 |
| 摘要失败但答复存在 | 查看 `summary.saved` 和错误；只报告答复成功，记忆未写入 |
| 页面显示静态预览或固定案例 | 使用了 Pages 或 `.preview-site`；完整部署应运行 Compose 后端 |
| 多 worker 下偶发未登录/失效 | 恢复单 worker；当前进程内会话不能直接跨 worker 使用 |

## 8. 可直接发给团队 Agent 的任务说明

下面内容可复制，实际参数通过团队已有的私有渠道提供：

> 请拉取 `https://github.com/shuaishuaisylas/LifeOS` 的 `main`，先读根目录 `AGENTS.md` 和 `docs/Agent部署与验收.md`。我的目标是部署完整 Python/Docker 应用，而不是 GitHub Pages 模拟页面。请在我指定的机器与目录中执行；保留已有配置、账号和记忆卷。新部署按 `deploy/compose.env.example` 建立 `.env.compose`，模型凭据使用我提供的私有文件路径。先检查 Docker 和端口，再构建、启动并按手册验证路由、登录、真实问答、摘要、回访及持久化。缺少 SSH、模型配置或域名时只询问缺失信息，并继续完成独立的准备工作。最后报告访问地址、提交 SHA、Compose 项目名、实际验收结果和未验证项，不在报告中包含密钥、密码或 Cookie。

若只需要前端体验，请将目标句替换为：“我只需要静态交互预览，运行 `scripts/build_preview.py`，不接入真实模型，也不把模拟摘要描述成模型验收成功。”

## 执行层与测试台验收

本轮增加锁定 Claude Agent SDK、DeepSeek Anthropic 兼容入口和 /workbench.html。部署后用现有账号登录测试页，分别选择 native / claude-sdk，核对来源、工具轨迹、摘要保存和连续测试。对比使用独立测试会话；原产品数据不复制或修改。回切设置 AGENT_RUNTIME=native 后重启 backend。详细接口、上下文策略、功能边界见 [执行层与测试台](执行层与测试台.md)。


## 完整评测工作台验收

当前 `/workbench.html` 增加评测集、批量 A/B、五环节和独立整体判定、人工复核、提示词版本/组合/启用。按 [工作台手册](评测工作台.md) 验证：创建并修改一个虚构用例，确认历史版本保留；选择两方案运行；查看五环节证据及整体结论；保存人工备注并导出；编辑一个模块，确认产品启用 ID 没有变化；测试新组合，再启用并回滚。验证账号无法读取其他账号的任务或结果、产品记忆不受测试影响。

运行卷新增 `prompts.sqlite` 和 `evaluations.sqlite`，原 `memory.sqlite` 和 `workbench/tests.sqlite` 保留。部署更新前按手册备份现有卷，使用原 .env.compose、项目名及卷执行 `up -d --build`。正在运行的批次会因重启变为 interrupted；从任务页用原快照重跑。不要删卷或更换部署项目名。

前端允许评测集导入最多 2 MB，后端仍按接口限制请求体；每集最多 200 例，每例最多 20 步，最多 A/B 两方案。后台单队列，同账号最多三个未完成任务。队列完成仅证明执行/判定流程可用，模型效果需要团队复核样本。
