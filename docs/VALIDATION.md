# 验证记录（2026-10-24）

环境：

- Windows 10/11 x64，双屏（5120×1392 工作区）
- Node `v24.18.0`，npm `11.16.0`
- OpenCode `v2.1.3`（内嵌 Bun `1.4.4`，Node 兼容 `26.3.0`）
- `dsh-pet@0.3.8`（npm 安装到 `oc-pet/node_modules`，未改源码）
- Electron `43.3.0`（由上游自动下载到 `~/.dsh/electron`，137.7 MB，20.1s）

## 1. CLI 插件运行时

在 `spike/project/.opencode/plugins/oc-pet-spike/tui.ts` 里记录：

| 项 | 结果 |
| --- | --- |
| `setup` 是否随 TUI 启动 | ✅ pid/cwd/argv 与 TUI 一致 |
| 运行时 | ✅ Bun 1.4.4（`process.versions.bun`） |
| `child_process.spawn` | ✅ 拉起 `node --version`（v24.18.0）与自身 `--version`，退出码 0 |
| `node:fs` | ✅ 可写文件 |
| 事件订阅 | ✅ `context.data.listen` 收到服务端事件 |
| 插件重载 cleanup | ✅ 改文件后 `stage=cleanup cleanups=3` → 重新 `setup` |

结论：**方案 A1（宿主/daemon 嵌进 CLI 插件侧）在运行时上可行**，不需要服务器插件也能启停。

## 2. 上游 standalone 真实启动

```sh
node node_modules/dsh-pet/lib/standalone.js --port 3180
```

- ✅ 服务监听 `http://127.0.0.1:3180/`
- ✅ 自动下载 Electron（137.7 MB / 20.1s）并拉起透明窗
- ✅ 截图确认宠物出现在桌面右上角（蓝毛小女仆）
- ✅ `GET /dsh-pet-7340/config` / `/state` 正常
- ❌ `POST /work-status` 无 token → 403（预期）
- ✅ 从 `~/.dsh/dsh-pet/standalone-runtime.json` 读取 `port` + `token` 后 POST → 200，宠物切「思考」并弹气泡

关键发现：**runtime 文件就是官方给本机启动器留的能力文件**，不需要改上游就能拿到 token。

## 3. OpenCode 事件流（真实会话）

`opencode run --model cmdc-wen/deepseek/deepseek-v4.1-flash "Run the shell command \"echo oc-pet-e2e\"..."` 期间，CLI 插件收到的事件（节选）：

```text
session.created
session.inbox.enqueued / session.inbox.delivered
session.execution.started
session.step.started
session.reasoning.started / delta / ended
session.text.started / delta / ended
session.tool.input.started
session.tool.input.ended
session.tool.called
session.tool.progress
session.tool.success
session.step.ended
session.step.streamed
session.execution.succeeded
session.usage.updated
shell.created / shell.exited
```

事件负载：`{ details: { type, data: { sessionID, ... }, location, ... } }`；工具名在 `session.tool.input.started` 的 `data.name`，参数在 `session.tool.called` 的 `data.input`。

## 4. 状态映射端到端

同一次真实会话，适配层写入 `/state` 的序列：

```text
idle
working | 调用 shell
working | shell: echo oc-pet-e2e
result  | shell 完成
success | 任务完成
```

- ✅ 任务气泡文案来自工具参数，超过 40 个码点会被截断（上游硬限制）
- ✅ 成功后 8s 自动回 idle（TTL）
- ✅ 无 400/500

## 5. 生命周期

| 场景 | 结果 |
| --- | --- |
| 已有 daemon 时启动 TUI | ✅ 复用（`spawned=false`），不重复起窗 |
| 没有 daemon 时启动 TUI | ✅ `node lib/standalone.js` 拉起，`spawned=true` |
| 正常退出 / 插件重载 | ✅ cleanup 清工作状态；最后租约释放后停 daemon（`stopDaemon`） |
| 强制杀 TUI | ✅ 独立 watchdog 2s 内发现，清状态、停 daemon、删 stale runtime |
| 多 TUI（实验中被全局 cli.json 热加载触发） | ✅ 租约计数到 4，关闭时逐个释放；watchdog 在最后一拍后决定是否停 daemon |
| daemon `/shutdown` 卡住 | ✅ 4s 后 watchdog 强制结束；Electron helper 通过 host-liveness 自行退出 |

## 6. 加载路径

| 方式 | 结果 | 说明 |
| --- | --- | --- |
| 项目 `.opencode/plugins/oc-pet/tui.ts` 转发 | ✅ | 最稳的本地开发方式 |
| 全局 `cli.json` + 本地目录（`"D:/.../oc-pet"`） | ✅ | 隔离 `XDG_CONFIG_HOME` 实测；包根 `tui.ts` 被正确识别 |
| 全局 `cli.json` + npm 包名 `"oc-pet"` | ⚠️ 未发布 | 会尝试 npm install；本地包因此 `NpmInstallFailedError`。发布后应可用 |
| `opencode.json` 的 `plugins` | ⚠️ | 后台服务缓存插件列表；需要 `opencode reload` 或重启服务 |
| `OPENCODE_CLI_CONFIG_CONTENT` | ❌ | 本版本未生效（不推荐依赖） |

重要副作用：**改全局 `cli.json` 会热加载进所有正在运行的 TUI**。实验时请用项目级 `.opencode/plugins` 或隔离 `XDG_CONFIG_HOME`，不要直接改用户全局配置。

## 7. 契约测试（扩展后）

```sh
cd oc-pet
node scripts/verify-upstream.mjs
```

结果：**32 项全过**（版本/入口文件/engines/菜单裁剪 marker/三个移除项/runtime 字段/health/config/state/work-status POST+DELETE/lock→anim→broadcast→release/menu item 注册·查询·删除/standalone-ai settings/pet-display/shutdown）。

## 8. 剩余功能接线（第二轮）

### AI 自动配置

- 读取 OpenCode `opencode.json` + `auth.json`，当前模型 `cmdc-wen` / `deepseek/deepseek-v4.1-flash`，Base URL `https://api.commandcode.ai/provider/v1`
- `POST /standalone-ai/settings` 后 `GET` 返回：`enabled=true`、`hasKey=true`、`automaticWhispers=true`、`whisperIntervalSec=300`
- `POST /whisper?pet=main&surface=desktop` → `{ok:true, text:"他太过分了，我都想替你骂回去。", image:"要不直接骂他"}`
- `POST /chat?pet=main&surface=desktop` `{"text":"你好呀，今天心情怎么样？"}` → `{ok:true, text:"挺好的呀，傍晚了，有点想偷个懒～"}`

### 余额

- 自动刷新（主实例）成功：`5h额度已用 3%\n2.2 小时重置`，档位动画 `余额-数金皱眉`
- 第三方菜单：`sections.menu = { items:[{owner:"oc-pet", label:"查看余额"}] }`
- 模拟菜单点击 `POST /menu/click {owner,label,pet}` → `delivered:true`，8s 内再次出现 `余额刷新：ok`
- 说明：host 的 `sections.balance` 仍是 `{ok:false,provider:"standalone",reason:"unsupported"}`（standalone 的 `agentDefaultModel` 固定为 `standalone`）。适配层绕过 host 的 `/balance`：自己用 OpenCode 凭据调用上游 provider 的 `fetch`，自己选档位动画、`/lock` → `/anim` → `/broadcast` → 释放锁。
- 内置「查看余额」菜单已裁掉，改由「更多 → 查看余额」触发。

### 菜单裁剪

- `sprite.js` 含 marker `oc-pet: menu trimmed for OpenCode`
- 已移除：打开网站 / 内置查看余额 / 显示位置
- 保留：碎碎念 / 对话 / 回到初始位置 / 重载配置 / 动作
- 插件 setup 应用补丁后调用 `POST /reload` 重启 helper，菜单即时生效

### 系统通知

- 使用 CLI 插件 `context.attention.notify`
- 只由**主实例**（租约里 PID 最小的 TUI）发送，避免开多个 TUI 弹多次
- `notification.when="blurred"`：聚焦时不打扰；事件覆盖 `permission.asked`、`session.execution.succeeded/failed/interrupted`、`session.compaction.failed`
- 真实系统 toast 未在“失焦”状态下自动化验证（需要把终端切走）；代码路径已接入。

## 9. 多会话 / 多模型 / 配置热重载（第三轮）

- 每个会话的模型从 `session.step.started` 的 `data.model` 和 `session.model.selected` 记录到 reducer；
- 宠物是单实例：`activeModel()` 跟随**它正在展示的那条会话**（活跃优先，终态 TTL 内其次）；没有会话时回落到主 TUI 的 `context.ui.model.current()`；
- `model-sync`：主实例每 5s 对比 OpenCode 配置/凭据与 standalone AI 设置：
  - 同一 endpoint 只 patch `model + apiKey`（保留 baseUrl/自动碎碎念等）；
  - 换 provider/endpoint → 整份更新；
  - 没有 key/provider 配置 → 保持上一份 AI 设置，只告警一次；
  - 每次同步都会重新读 `opencode.json` / `auth.json`，所以配置热重载最迟 5s 生效；插件自身热重载会重新 setup。
- 单测：`events` 13 项 + `model-sync` 1 项 = **14 项全过**（首次全量、同模型不重复写、同 endpoint 换 provider patch、换 endpoint 全量、无 key 只告警一次）。
- 实测：当前活跃会话 `cmdc-wen/deepseek/deepseek-v4.1-flash`；热重载后日志出现「模型同步：…」，AI 设置保持 `enabled/hasKey`。
- 凭据：`opencode auth export` 实测返回 5 个 per-provider key（`opencode-go`、`deepseekwild`、`cmdc-wen`、`cmdc-kun`、`cmdc-huan`）。适配层优先用同名 provider 的 key，避免把 Wen 的 key 用到 Huan 上；`cmdc-huan` 账号本身额度不足，真实调用未能完成（这是账号状态，不是插件问题），同步逻辑由单测覆盖。
- 行为：多会话用不同模型时，宠物跟着**最近活跃的那个**切；不是每个会话一只。`/pet-balance`、`/pet-whisper`、`/pet-chat` 与桌面右键菜单都使用这条活跃会话的模型。
- 局限：`opencode auth export` 不可用时回退 `auth.json`/env；多账号 key 只在 OpenCode DB 且 export 失败时需 `/pet-ai`；`/pet-ai` 里改模型会被同步覆盖。

## 10. 已知限制 / 下一步（更新）

1. **必须有 Node.js ≥ 22.12**（上游 standalone engines）。OpenCode 自身是 Bun 单文件，不保证用户机器有 Node；后续可改用 Electron app 入口或打包 Node runtime。
2. **没有 Web 浮层**：OpenCode 没有 DSH 的网页插件插槽，宠物只以桌面透明窗存在。
3. **DSH 同时运行**：若 DSH 走 in-process（非 standalone），两边会各起一只；需要后续做「共享 pet host」探测。
4. **强杀收尾有 4–8s 延迟**：daemon 的 `server.close()` 会被 keep-alive 连接拖住，watchdog 兜底强杀。
5. **全局 cli.json 热加载**：实验时容易误加载到用户正在跑的 TUI；文档已标注。
6. **`/state` 的 idle 形态**是 `{ state: null, task: null }`，不是 `null`；消费端按 `state` 判断。
7. **模型跟随是单宠物口径**：多会话不同模型时跟随最近活跃会话；不是每个会话一只。
8. **菜单裁剪依赖 `sprite.js` 三个字符串锚点**：上游大改会明确报错（契约测试红），需更新 `src/menu-patch.mjs`。
9. **host 的 `sections.balance` 仍为 unsupported**：余额动画/气泡由适配层驱动，不写 host 的 balance 段；如果有第三方读 `/state` 的 balance 段，会看到 unsupported。
10. **通知未做“聚焦时也弹”选项**：当前固定失焦才弹，避免打断。
11. **provider key 优先 `opencode auth export`**（多账号 per-provider），回退 `auth.json`/env；export 不可用时需 `/pet-ai` 手动填。
12. **模型/config 同步最多 5s 延迟；key 热更新最多 30s（export 缓存）**；`/pet-ai` 改模型会被覆盖，切模型请用 `/models`。
