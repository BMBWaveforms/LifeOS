# Mac 备忘录与提醒事项接入调研

调研日期：2026-10-15。范围：苹果官方文档、现有网页 / Docker 架构和本机静态接口检查；尚未开发接入功能，未请求系统授权，未读取或写入任何个人笔记、提醒事项。

## 结论与优先级

可以接入。建议先做“用户主动点击 → 创建一条提醒 / 保存一份摘要”的单向导出，再决定是否开发常驻 Mac 小助手和双向同步。

| 用途 | 首选 | 原因 |
|---|---|---|
| 指定时间再问进展、执行下一步 | 提醒事项 Reminders | 有日期、提醒和完成状态，符合问题回访 |
| 收藏指南、保留一次咨询摘要 | 备忘录 Notes | 更适合正文、来源链接和长期查阅 |
| 后台自动同步、读取完成状态 | Mac 本机小助手 | 需要系统授权、可靠回执和同步状态管理 |

在提醒事项中打勾只代表完成这次行动 / 提醒，不自动代表原问题已解决。应回传为“行动已完成”，再由用户在苟活确认问题进展。

## 已证实的接入方式

### 提醒事项：EventKit 是正式原生接口

EventKit 可以访问提醒数据。当前接口通过 `requestFullAccessToReminders` 请求授权，允许创建、读取、修改和删除；提醒没有与日历事件相同的只写授权模式。原生应用需配置相应隐私说明；沙盒 Mac 应用还需按目标系统配置 entitlement。产品承诺“只处理苟活清单”属于我们的访问限制，不能声称操作系统只授予这一张清单的权限。[苹果 EventKit 授权文档](https://developer.apple.com/documentation/eventkit/accessing-the-event-store)、[提醒事项隐私说明](https://developer.apple.com/documentation/bundleresources/information-property-list/nsremindersfullaccessusagedescription)

提醒事项具有完成状态；跨客户端完成时 `completionDate` 可能为空，应以 `isCompleted` 为依据。[苹果完成状态说明](https://developer.apple.com/documentation/eventkit/ekreminder/iscompleted)

### 备忘录：本机脚本 / 快捷指令可行，没有查到通用服务端 API

本机系统应用 `Notes.app` 附带 `Notes.sdef`，声明了笔记、文件夹、ID、HTML 正文和只读纯文本等脚本能力；`Reminders.app` 同样声明清单、标题、备注、日期、完成状态等。本次只读取应用包内的字典文件，没有向两个应用发出脚本事件。苹果说明 `.sdef` 是可脚本应用公开命令和属性的依据，但不同系统版本仍须实测。[苹果脚本字典说明](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/AboutScriptingTerminology.html)

AppleScript 控制 Notes 涉及 macOS“自动化”许可，首次运行的提示及权限归属需在实际分发的小助手中验证。[苹果自动化许可说明](https://support.apple.com/guide/mac-help/mchl07817563/mac)

截至本次调研，未找到苹果官方向第三方开放的 Apple Notes 通用读写 SDK 或 Notes / Reminders 服务端 REST API。这个结论是本次官方资料检索的边界，不等于对所有未来接口的保证。`App Intents` 的 `.notes` 是让开发者自己的笔记应用向 Siri / Apple Intelligence 暴露动作，并不授予 Apple Notes 内容访问权；CloudKit 也围绕获授权的应用容器，不是读取苹果 Notes 容器的通道。[Notes App Intents](https://developer.apple.com/documentation/appintents/app-schema-domain-notes)、[CloudKit 容器](https://developer.apple.com/documentation/cloudkit/ckcontainer)

### 快捷指令：适合最小可用版

苹果支持从网页链接启动用户已经安装的快捷指令，并传入文本：

```text
shortcuts://run-shortcut?name=<已安装的指令名称>&input=text&text=<URL编码的输入>
```

也支持 `x-success` / `x-cancel` / `x-error` 回调；“打开了快捷指令”不能视为写入成功，需要成功回执或明确显示尚未确认。[URL 启动说明](https://support.apple.com/guide/shortcuts-mac/apd624386f42/mac)、[回调说明](https://support.apple.com/guide/shortcuts-mac/apdcd7f20a6f/mac)

Mac 本机可以运行 `shortcuts run` 并用输入 / 输出文件衔接进程；需要交互的指令会等待用户操作，不能假设适合无界面后台运行。[苹果命令行说明](https://support.apple.com/guide/shortcuts-mac/apd455c82f02/mac)

## 当前架构的边界

现有正式产品是网页 + Python 后端，完整应用在 Docker 中运行。Docker Desktop 的容器位于 Linux 虚拟机内，不能直接调用宿主 Mac 的 EventKit 或 Notes AppleScript；把数据库目录挂进容器也不等于获得系统许可。普通网页同样没有 EventKit / Apple Events 权限，需要快捷指令或本机应用桥接。[Docker 官方隔离说明](https://docs.docker.com/desktop/setup/install/mac-permission-requirements/)

Mac 创建到 iCloud 清单 / 文件夹后，在同一 Apple Account 且开启对应 iCloud 功能的设备上可由系统同步。该同步是 Apple 系统能力，不代表苟活后端获得了 iCloud 数据 API。[提醒事项 iCloud 设置](https://support.apple.com/guide/icloud/mmbf52194b5a/icloud)、[备忘录 iCloud 设置](https://support.apple.com/guide/icloud/mm8685520792/icloud)

云服务器不能自行访问用户 Mac 权限或唤醒离线的 Mac。手机打开苟活网页时，`localhost` 指手机自身；不能沿用 Mac 的本机网页地址。手机可另装对应快捷指令进行手动导出，或在未来通过云端队列交给配对的 Mac 执行；这两条路线均待原型验证。Mac 离线时只能显示“待处理”，不能提前报告已创建。

## 建议的 MVP 路线

1. **手动单向导出**：在咨询 / 回访卡片提供“提醒我”和“存到备忘录”。用户先确认标题、日期、摘要和目标清单 / 文件夹，再启动安装好的固定快捷指令。只传这一次的必要内容，不传完整聊天、账号 Cookie 或密钥。收到可靠回执后标记成功；取消、失败、回执缺失分别处理。Notes 先保存纯文本摘要与指南来源，富文本、附件和受锁笔记暂留待验证。
2. **需要自动同步后再做小助手**：分发有固定应用身份的 Mac `.app`。Reminders 采用 Swift + EventKit，Notes 采用固定 AppleScript / Shortcuts。首次在界面申请对应权限，配对苟活账号；小助手主动从后端领取有限类型的任务并回报结果，避免开放一个能接受任意脚本的本机接口。撤销权限、退出账号或 Mac 休眠时可见地暂停。
3. **最后做有限双向同步**：仅同步苟活创建、带有应用标识的条目和用户选择的清单。先回传完成状态，再考虑标题 / 时间修改；不扫描用户全库，不将私人笔记默认送给模型。关闭记忆、导出副本与删除外部条目是不同操作，界面明确各自作用。

## 双向同步必须补的约定

- **稳定业务 ID**：为问题增加稳定 `problem_id`，摘要更新后仍沿用。当前每轮可生成新的 `memory_id`，不适合作为外部条目的唯一身份。每次动作另有 `operation_id`，重试先查结果，避免创建重复提醒。
- **外部映射**：保存账号 / 设备 / 目标容器 / 外部条目 ID / problem_id / 最近同步版本。EventKit 本地 `calendarItemIdentifier` 在完整同步后可能丢失，不能当跨设备永久主键；还需在苟活自有条目中保留可恢复的业务标识，具体字段方案在原型中验证。[苹果标识说明](https://developer.apple.com/documentation/eventkit/ekcalendaritem/calendaritemidentifier)
- **删除与冲突**：删除产生 tombstone 和版本记录，旧任务不得重建已删条目；外部找不到条目要区分用户删除、权限丢失和标识变化。只删除明确由苟活创建并仍匹配映射的条目。用户手改内容不被旧摘要静默覆盖。
- **结果语义**：创建、更新、取消同步、标为完成、问题解决分别记录。EventKit 保存成功不等于所有 iCloud 设备同步完成，也不等于到时一定弹出通知；通知设置、专注模式等需要实际验收。

## 本次已检查与尚未验证

已检查：本机 macOS `27.0.1`（build `26A434`）；`shortcuts --help` 可用；两个系统应用的 `.sdef` 文件存在，声明了上述脚本对象与属性。未列举快捷指令、账号、笔记或提醒数据。

待原型验证：目标系统版本中的快捷指令具体动作和 ID 回执；首次授权 / 拒绝 / 撤销后的行为；小助手签名、分发与后台权限；重复点击 / 超时重试；删除 / 编辑冲突；iCloud 与跨设备 ID；日期、时区、全天与定时提醒；Mac 离线恢复；手机导出和云部署地址；锁定 / 共享 / 富文本笔记的边界。没有执行写入，因此本报告是可行性调研，不能作为“已接入 / 已验收”的证明。
