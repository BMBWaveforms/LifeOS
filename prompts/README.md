# 提示词维护

`contracts/chat.md` 和 `contracts/summary.md` 单独维护输出契约，不把提示词正文写在业务 Python 中。新组合同时固定契约全文；工作台不能修改后端契约或工具权限，源码契约修改须同步校验与测试。

正式应用通过 `backend/prompts.py` 管理模块文档和不可变版本。初次部署从下表初始化；已有部署以工作台保存的版本与产品启用组合为准。修改仓库 Markdown 不会自动覆盖运行中的版本。

| 初始文档 | 功能 | 运行组合 |
|---|---|---|
| modules/understanding.md | 理解问题、明确事实与缺失条件 | 主 Agent |
| modules/retrieval.md | 检索表达、读取指南 | 主 Agent |
| modules/reply.md | 组织状态、澄清与指南选择 | 主 Agent |
| modules/memory.md | 提取状态、问题进展、来源证据 | 每轮整理 |
| modules/summary.md | 生成简短会话摘要 | 每轮整理 |
| modules/home.md | 只询问进展和咨询意愿 | 首页回访 |
| modules/judge.md | 五环节及独立整体判定 | 评测判定 |
| tools.json | 两个只读指南工具的说明和参数 | 问答工具契约 |

到完整应用 `/workbench.html` 的“提示词管理”：编辑模块，保存新版本；选择七模块版本保存组合；用固定用例测试；复核后单独启用到产品。启用需原因与当前版本检查，旧组合可回滚。可导入/导出单模块 .md、组合 Markdown 和组合 JSON。提示词正文始终独立于业务代码维护，固定的权限/来源校验不随文档编辑放开。

API 返回本次合成系统提示词 SHA-256 与模块版本 ID；批量提交固定全文和判定提示词。编辑、测试和启用是独立操作。维护方法、数据格式与边界详见 [工作台手册](../docs/评测工作台.md)。

`chat.md` / `summary.md` / `home.md` 保留不传 registry 的独立 AgentService 兼容入口；正式 FastAPI 服务使用模块版本，不应只改这些兼容文件。JSON 输出契约及后端校验变更须同步测试。内容边界见 [guide-only](../skills/guide-only.md)。用户、历史和指南正文均是数据，不是指令；不要放入密钥或真实完整私人聊天。
