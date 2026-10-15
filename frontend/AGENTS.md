# LifeOS 产品前端

先遵守根 AGENTS.md。本目录根 `index.html` 是唯一产品入口 `/`，已融合 Horizon 团队交付；`workbench.html`、`workbench.js` 与 `evaluation.*` 是独立内部评测工具。

产品使用原生 ES modules，不需要 npm 构建。保留团队确认的桌面、黑白、视频 Landing、场景点击直接发问、独立无输入进入对话、历史搜索/重命名与排序、只读理解面板、产品内指南阅读和不含私人对话的 PNG 分享。演示项目只作分组示例，不代表真实项目 API。

真实服务已实施自动记忆策略：所有产品账号自动开启，页面和产品接口均不提供关闭或纠正。`GET /api/memories` 返回主题、原话来源与 `policy=automatic_delete_only`；用户可删除单条来源、整个主题或全部记忆。相关原话会持久保存，必须在界面明确说明并支持查看/删除。主题摘要是缓存；删除来源后不能继续显示或恢复含已删事实的摘要、续聊关联和恢复卡片。

`service.mjs` 是真实/演示协议边界；`memory-topics.mjs` 管主题呈现与本地删除失效。DemoService 仅演示，不能代替真实 Agent 或伪装模型流。真实问答仍等待最终校验 JSON；SDK 私有事件和思维链不得进入产品页面。

`runtime.json` 只有公开开关，不放密钥。静态预览复用同一根产品并强制 `real_api_enabled=false`，不得打包工作台、账号、配置或运行数据。指南副本必须和权威 `data/guide.json` 及许可保持一致；视频许可随 assets 保存。

修改后运行 `node --test tests/horizon/*.test.mjs`、`node --test tests/*.cjs`、`python scripts/build_preview.py` 和相关后端契约测试。仅自动测试/演示通过不能宣称真实模型、跨设备历史或服务端流式已验收。
