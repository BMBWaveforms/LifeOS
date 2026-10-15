# Horizon 候选前端

先遵守根 AGENTS.md，再读 docs/handoff/horizon/README.md。本目录仅候选产品 `/horizon/`，原默认产品与工作台保持独立。

用户已确认：桌面、黑白、视频 Landing、固定产品 slogan、场景点击直接发问、额外无输入进入对话、历史搜索/重命名、项目只做分组示例而非文件夹、记忆自动开启且用户只能删除、理解面板只读、指南在产品内阅读、PNG 分享不能含私人对话。

这里“自动记忆”是新版产品要求，与根文档描述的当前后端默认关闭/可纠正策略冲突。不要偷偷修改生产账号或恢复旧版开关；按交接文档把服务端策略迁移作为接入任务。真实模式在账号 enabled=false 时保留输入并拒绝提交，未声明服务端已完全符合新策略。

service.mjs 是协议边界；DemoService 仅用于演示。runtime.json 只有公开开关，不放配置/密钥；静态预览必须 real_api_enabled=false。现后端仅最终 JSON；不要把演示分片说成真实模型流，不能展示未校验的 SDK 内部事件。

原生 ES modules，无 npm 构建。检查 node --test tests/horizon/*.test.mjs 与根完整 CI。指南副本须和 data/guide.json 同步；脚本静态预览使用权威 data/。素材许可随 assets 保存。不要把登录文件、浏览器历史、截图里的私人数据加入仓库。
