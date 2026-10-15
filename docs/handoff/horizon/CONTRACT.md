# API 对照与待实现协议

## 已有接口：按基线源码核对

来源：`frontend/services.js`、`backend/main.py`、`backend/model.py`、`backend/store.py`。下列路径已经存在，Horizon 的 `RealService` 用同源 cookie，不接受浏览器传来的模型密钥。

| 请求 | 输入 | 响应及前端用途 |
|---|---|---|
| GET /health | 无 | `model.configured` 仅表示发现配置，不能证明模型可调用；runtime 元数据不作为用户推理内容 |
| GET /api/me | cookie | `{user:{id,name}}`；401 显示登录 |
| POST /api/login | `{username,password}` | `{user}` + HttpOnly cookie；密码不写前端存储 |
| POST /api/logout | `{}` | 清除服务端会话；前端重置当前模式视图 |
| GET /api/memories | cookie | `{enabled,revision,memories,effective,feedback}`；enabled=false 时 Horizon 阻止真实提问，无隐式 settings 写入 |
| POST /api/run | `{mode:'chat',query,conversation_id,followup_memory_id}` | 最终 JSON：`conversation_id`、`result`、`summary`；即便前端发送了本机 ID，必须保存服务端实际返回的 ID |
| POST /api/run | `{mode:'home',query:'',conversation_id:'',followup_memory_id:''}` | result.followups：`memory_id,topic,progress_question,guide_question,guides,last_discussed`；页面显示一条 |
| POST /api/memory-action | `{action:'delete',id}` 或 `{action:'clear',confirmed:true}` | 新的记忆状态；后端当前 clear 不以 confirmed 字段做安全授权，仍须账号鉴权；前端已先确认 |
| GET /api/guide-entry?guide_id=03-01 | cookie | 完整固定指南条目；已有答复 card 含正文，Horizon 当前直接读该 card |

后端还接受 `guide_id`、`runtime` 等字段，但本版视频场景发送自然语言，不把视频映射成强制指南 ID，也不在产品端切执行层。`requestId`、`clarification`、`onProgress` 是当前前端 service 接口参数，RealService **没有向现有后端发送它们**。

现有 `result` 可是对象，旧兼容代码也容忍 JSON 字符串。状态：`answer / partial / unsupported / clarification / acknowledged`。`cards` 是服务端全文读取并校验后合并的指南条目，含 `guide_id,title,fields,full_text,source_locator,match_reason,memory_ids` 等；不要用模型自由文本替代。追问字段 `clarification` 是字符串；现有 finalize 不保留前端演示的快捷选项。

`summary`：`saved:boolean,message:string`，成功时含 `memory_id,memory_revision`；保存失败不等于答复失败。未知/问候/追问等情况允许不生成摘要。后端实际更多 `execution / prompt_versions / tool_calls` 等字段前端会忽略；它们不是展示链路的必要字段。

`memories[]`：`id,text,kind,state,created,updated,expires`；模型摘要另含 `origin:'model_summary',problem,user_state,problem_status,guide_ids,followup_of,guides`。时间为 Unix 秒，前端兼容秒与毫秒。`effective` 才是实际有效集合，enabled=false 时为空；不要把“前端有当前标签”当成服务端已经启用记忆。

后端真实响应与指南的契约由 `tests/test_horizon_contract.py` 验证，前端映射由 `tests/horizon/integration.test.mjs` 验证。这是合成模型测试，不是收费模型端到端验收。

## 必须尊重的当前限制

- 401 登录失效保留输入；400/409 使用服务端 message，不能自动无限重试。账号并行锁可能返回409；删除记忆、变更 runtime/提示词会使短期上下文失效并产生新的 conversation_id。
- 当前聊天上下文在后端进程内，按账号隔离，仅保留最近12条消息并清理一小时未活跃会话。重启/其他worker不会恢复产品完整历史。浏览器历史继续使用返回的新ID。
- 当前后端能关闭/编辑摘要，Horizon 不展示相关按钮。前端预检无法代替服务端权限策略，跨标签修改可能发生竞态，属于P0待处理事项。
- 摘要没有持久化 source_conversation_id；不要把 memory.source_run 的内部令牌发给前端当来源链接。关联须另建受账号授权的数据字段。
- 浏览器取消 fetch 不能证明后端停止。生产请求没有幂等/操作查询契约。重试可能产生新结果/摘要；前端已保留不确定状态。

## 建议扩展：未实现，不得按已有接口调用

下面是给后端 Agent 的最小设计输入，具体路径/版本/持久化方案由后端核对现架构后实现；不提前创造可调用的假 API。

### 真实流式

前端已提供 `submit({...,signal,onProgress})`；UI 当前消费 `{type:'text_delta',text:string}`，最终 Promise 返回上述完整答复对象。 展示层 `runReplySequence` 立即启动请求，但将首屏转场、用户消息阅读停顿和回复显示分开；真实JSON答复也遵守这个顺序。`onProgress` 可以返回Promise，提供方需 await 后再继续分片/完成，以保留停止语义；不要另写一份后端延时或把最终JSON伪装为模型流。适配器负责解析传输，只有已校验且允许公开的文本才可进入 UI。最终 card/summary 以最终校验结果为准，不根据分片先保存记忆。

建议传输事件 envelope：

```json
{"version":1,"request_id":"opaque-id","seq":1,"type":"text_delta","text":"公开的答复片段"}
```

最后一条建议为 `type:'completed', response:{conversation_id,result,summary}`；失败为 `type:'error',code,message,retryable`。序号去重、跨连接恢复、断线后查询、超时和停止语义必须服务端/适配器共同实现。当前 UI 只认识 text_delta，completed/error 需要适配器转换为 resolve/reject；不能仅新增路由便宣称完整接入。

如果现 Agent 只在最终校验后才能确认自由文本安全，先保留非流式 JSON。不要把未经校验的模型 token、SDK 工具参数、系统提示词、原始 trace、私有记忆快照或思维链发送浏览器。若先做“查找指南”等进度，应采用固定公开阶段枚举，不能冒充真实推理过程。

### 历史与来源

建议历史数据：会话ID、title、created/updated、project_id?、turns/分页、draft另定；每轮ID、query、validated response、status、server conversation ID。所有查询/删除/改名/搜索须按账号授权。需要定义保留期、分页、删除原文与保留摘要的区别；不能借用工作台会话API。

建议记忆新增 `source_conversation_id / source_turn_id / source_available`；从记忆跳转需先确认来源仍存在且归属当前用户。来源删除时，只带当前有效摘要创建新聊天，不恢复已删原文；同一摘要恢复聊天应可复用。当前本机实现不代表跨设备已支持。

### 追问与理解

追问可增加 `clarification_options:[{id,label,value}],allow_skip:boolean`；纯字符串仍兼容。选项值与跳过进入同一多轮上下文，不伪造未知条件。

理解面板若改用后端数据，建议每条明确事实都携带可授权的 source_turn_id 与原文引用，并标示未知项；现 `understanding.intent/explicit_facts/unknowns/scope` 属任务理解，需要先映射，不是直接输出整段推理。

### 幂等、取消、项目

幂等键以账号+request_id 作用域，必须定义请求正文变化冲突、保留期、final结果与摘要去重、断线查询和停止后的最终状态。演示服务的 operations 映射不能复制为生产任务存储。

项目仅是当前演示分组。若落地真实项目，须单独定义成员归属、项目与会话关系、跨会话上下文是否共享及删除语义；不要默认把所有组内原文送给模型。

## 侧栏排序属于客户端偏好

`conversation-ordering.mjs` 只处理本机历史的 ID 顺序，不调用 Agent 或更改原消息。每个提供器/账号在原历史键的 `.order` 项下保存 `{version:1, groups:{recent:[id,...], "project:<id>":[id,...]}}`。一次移动保存该组全部已有 ID，避免只保存侧栏可见6条后让隐藏历史挤到前面；过期/重复 ID 忽略，新对话置于已保存顺序前，打开旧对话不打乱手动顺序。恢复默认清空偏好并回到最近使用顺序。

演示使用 localStorage，真实模式使用当前账号的 sessionStorage；没有跨设备同步、服务端项目或排序 API。将来增加服务端历史时需明确排序字段、账号归属、版本冲突与删除清理，不能把当前 `.order` 当成已存在的服务端协议。项目分组仍仅示例。
