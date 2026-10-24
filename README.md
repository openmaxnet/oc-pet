# oc-pet

OpenCode 的桌宠适配层：**不改 `dsh-pet` 上游源码**，复用它的桌面渲染（Electron 透明置顶窗）、106 段动画素材与宿主半侧，把 OpenCode 的会话事件映射成宠物的工作状态。

## 为什么不是 TUI 内嵌

`dsh-pet` 的宠物是 DOM + VP9-Alpha 视频 + 无边框透明置顶窗 + 跨屏拖拽/抛掷 + 右键菜单；OpenCode TUI 是终端单元格渲染，无法承载这些。OpenCode 的 Web UI 也没有文档化的 UI 插件扩展点。

所以本适配层是：

```
OpenCode TUI / 后台服务
  │  CLI 插件（setup/cleanup + data.listen 事件流）
  ▼
dsh-pet-standalone（独立 daemon，Node 子进程）
  │  runtime 文件里的 port + token
  ▼
dsh-pet 宿主半侧 + Electron 透明置顶窗
```

效果 = DSH 的「桌面模式」：动画链、点击/拖拽/甩抛、右键菜单、多开、自定义素材都保留；**没有**「嵌在网页右上角」的浮层（OpenCode 没有这个容器）。

## 已验证的加载方式

### 1. 项目内发现（本地开发最稳）

先把插件装进项目（会同时装上 `dsh-pet` 及其依赖）：

```sh
npm install /path/to/oc-pet
# 或：npm link /path/to/oc-pet && npm link oc-pet
```

然后：

```ts
// <project>/.opencode/plugins/oc-pet/tui.ts
export { default } from "oc-pet/tui"
```

已实测：TUI 启动时 `setup` 执行、事件订阅生效、重载/退出会 cleanup。

### 2. 全局 `cli.json`（CLI-only，连远程 server 也生效）

```jsonc
// ~/.config/opencode/cli.json（Windows: %USERPROFILE%\.config\opencode\cli.json）
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["D:/path/to/oc-pet"]   // 本地目录；包根有 tui.ts
}
```

已实测。发布到 npm 后可以写 `"oc-pet"`（需要先去掉 `private` 并发布）。

> ⚠️ **全局 `cli.json` 会热加载进所有正在运行的 TUI**。实验时建议用项目级 `.opencode/plugins`，或设置隔离的 `XDG_CONFIG_HOME`。

### 3. `opencode.json` 的 `plugins`

```jsonc
{
  "plugins": [{ "package": "oc-pet", "options": { "keepAlive": false } }]
}
```

CLI 会从 server 的插件列表里取 `./tui`。注意：**后台服务会缓存插件列表**，改完需要 `opencode reload` 或重启服务；实测不如前两种直接。

## 选项

```jsonc
{
  "package": "oc-pet",
  "options": {
    "dshHome": "C:/Users/you/.dsh", // 默认 $DSH_HOME 或 ~/.dsh
    "port": 3080,                   // 不传则由上游从 3080 起顺延
    "keepAlive": false,             // true = 关掉所有 TUI 后宠物继续留着
    "workStatus": true,             // false = 只启动宠物，不做事件映射
    "debug": false,                 // 详细日志
    "traceEvents": false            // 记录每条事件类型（排查映射）
  }
}
```

日志：`$DSH_HOME/dsh-pet/opencode-adapter.log`（超过 1 MB 自动截断）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/pet` | 显示 / 隐藏桌宠（写 `display`，不重启 daemon） |
| `/pet-status` | 当前档位、任务气泡、会话数、daemon 端口 |
| `/pet-balance` | 立即查询并展示余额（档位动画 + 头顶气泡） |
| `/pet-whisper` | 让桌宠立即碎碎念一句（说话动画 + 气泡） |
| `/pet-chat <一句话>` | 与桌宠对话（回复走气泡，记忆持久化） |
| `/pet-ai` | 打开 standalone AI 设置页（模型 / Base URL / 密钥） |
| `/pet-stop` | 停止 daemon（重新打开 TUI 可再次启动） |

### 模型跟随 / AI 配置

宠物是**单实例全局桌宠**，所以它的“脑子”跟随**它正在展示的那条会话**：

- 每个会话的模型从 `session.step.started` / `session.model.selected` 记录；
- 多会话使用不同模型时，宠物跟随**最近活跃的那条**（也就是工作状态正在展示的那条）；
- 没有活跃/终态会话时，回落到主 TUI 的 `context.ui.model.current()`；
- 主实例每 5s 对比一次 OpenCode 配置/凭据和 standalone AI 设置，变化后在 5s 内切换；
- OpenCode 配置热重载（改 `opencode.json` / `auth.json`）也会被这轮同步读到。

Provider → Base URL 映射（`opencode.json` 里 provider 的 `settings.baseURL` 优先）：

- `cmdc-*` / `commandcode` → `https://api.commandcode.ai/provider/v1`
- `opencode-go` → `https://opencode.ai/zen/go/v1`
- `deepseek*` → `https://api.deepseek.com/v1`
- 密钥：优先 `opencode auth export` 的 per-provider 凭证（多账号里取 `active`），回退 `auth.json` / `OPENCODE_GO_API_KEY` / `DEEPSEEK_API_KEY`

### OpenCode 官方订阅（OAuth，无需导出 key）

`opencode auth export` 里的 `type: "oauth"` 记录本身就带 `access`（`st_…`）与 `refresh`，适配层直接把它当 Bearer 用 —— **不需要**手动导出或复制 API key。

只有一处需要额外处理：Go 推理接口强制要求每次请求带 `x-opencode-session`（稳定会话 ID，见[官方说明](https://opencode.ai/docs/go/#where-can-i-use-it)），而 dsh-pet standalone 的 AI 传输层只发 `authorization` / `content-type` / `accept`，设置 schema 是 strict 的、没有自定义头字段。为不改上游源码，适配层在**本机回环**起一个小转接头：

```
dsh-pet standalone ──Bearer st_…──▶ 127.0.0.1:<随机端口>/v1/chat/completions
                                          │ 补 x-opencode-session + UA
                                          ▼
                          https://opencode.ai/inference/go/openai/v1/…
```

- 只监听 `127.0.0.1`，只代理 `/v1/*`；token 每次请求现取（OpenCode 自己刷新后 5s 内跟上）；
- 会话 ID 持久化在 `$DSH_HOME/dsh-pet/zen-session-id`（官方要求「稳定会话 ID」，影响路由与 prompt 缓存）；
- 生命周期跟随 TUI：插件 cleanup 时关闭（`keepAlive=true` 且 TUI 全关后，宠物还在但 AI 会不可用，重开 TUI 恢复）；
- 启动日志：`Zen 转接头就绪：http://127.0.0.1:xxxxx/v1 → …`；`OpenCode 官方凭证：oauth 订阅`；
- 余额：`GET /zen/go/v1/usage` 只需 Bearer，无需转接头，`/pet-balance` 直接读订阅用量。

> 官方 Go 文档明确允许「OpenCode 以外的 coding agent」接入，要求自报 UA 并带稳定会话头；转接头正是按这个要求补的（`user-agent: oc-pet/0.1.1 …`）。

行为细节：

- 同一 endpoint 只换模型 → 只 patch `model + apiKey`，保留 baseUrl / 自动碎碎念等设置；
- 换 provider/endpoint → 整份更新；首次配置会打开自动碎碎念（300s）；
- 当前模型没有配置/凭证 → **保持上一份 AI 设置**并写日志（不会把宠物弄哑）；`/pet-balance` 会明确提示 `credential-missing`；
- `/pet-ai` 页面主要用于 baseURL / 密钥 / 自动碎碎念；**模型字段会被跟随逻辑覆盖**，切模型请用 OpenCode 的 `/models`；
- 多 TUI / 多会话只有一个宠物，不能给每个会话配一只不同的宠物；宠物永远跟随当前展示的那条会话。

### 桌面右键菜单

OpenCode 没有 DSH 的“网页端 / 打开软件”，所以适配层会对桌面 helper 做一次**菜单裁剪**（只改 UI，不改业务）：

| 项 | 处理 |
| --- | --- |
| 打开网站 / 打开软件 | 移除（OpenCode 无对应宿主入口） |
| 查看余额 | 内置项移除，改到「更多 → 查看余额」（由插件查询并驱动动画/气泡） |
| 显示位置 | 移除（OpenCode 只有桌面端；显隐用 `/pet`） |
| 碎碎念 / 对话 | 保留（AI 已配置，走 host 原生 `/whisper`、`/chat`） |
| 回到初始位置 / 重载配置 / 动作 | 保留 |

裁剪是幂等的运行时补丁（`src/menu-patch.mjs`），契约测试会检查 marker；上游菜单结构变了会明确失败。

## 生命周期

| 场景 | 行为 |
| --- | --- |
| 第一次启动 TUI | 没有 daemon → `node lib/standalone.js` 拉起，宠物出现 |
| 再开一个 TUI | 复用同一个 daemon（租约计数），不会多一只 |
| 正常退出 / 插件重载 | cleanup 清工作状态；最后一个 TUI 退出后按 `keepAlive` 停或留 |
| TUI 崩溃 / 被强杀 | 独立 watchdog 2s 内发现，清状态；需要时停 daemon、删 stale runtime |
| 只跑 `opencode serve` / Web UI | 默认不显示（CLI 插件不加载） |
| 连远程 server | CLI 插件仍在本机跑，事件来自远程会话，宠物出现在本机 |

前提：本机有 **Node.js ≥ 22.12**（上游 standalone 的 `engines`）。首次运行上游会自动下载 Electron（约 110–140 MB，缓存在 `~/.dsh/electron`），之后启动约 1–2s。

## 上游同步（重点）

不 fork、不复制源码、不改 `node_modules`。升级流程：

```sh
cd oc-pet
node scripts/sync-upstream.mjs --check    # 当前 vs latest
node scripts/verify-upstream.mjs          # 当前版本契约测试（基线）
node scripts/sync-upstream.mjs --latest   # 装最新；失败自动回滚
```

`verify-upstream.mjs` 会用临时 `DSH_HOME` + `display:web` 起一个**不弹窗**的 standalone，验证：

- 包内入口文件存在 + 菜单裁剪 marker；
- runtime 文件字段（`pid` / `port` / `token`）；
- `/health`、`/config`、`/state`；
- `/work-status` POST + DELETE；
- `/lock` → `/anim` → `/broadcast` → `/lock/release`；
- `/menu/item` 注册 / 查询 / 删除；
- `/standalone-ai/settings`；
- `/pet-display`、`/shutdown`。

全部通过才允许升级。细节与破坏性变更处理见 [`docs/UPSTREAM-SYNC.md`](docs/UPSTREAM-SYNC.md)。

## 已验证 / 未完成

已验证（2026-10-24，Windows + OpenCode 2.1.3 / 2.1.4 + dsh-pet 0.3.8）：

- CLI 插件加载、Bun 运行时、`spawn`、文件系统；
- 事件流 → 6 档工作状态：`idle → working → result → success` 真实会话跑通；
- 余额：真实 Command Code 额度（`5h额度已用 3%`）+ `余额-数金皱眉` 动画 + 气泡；
- 碎碎念：AI 生成成功（含表情包配图）；
- 对话：AI 回复成功并写入气泡；
- 桌面菜单裁剪 + 「更多 → 查看余额」第三方菜单点击；
- 系统通知：已接入 `context.attention.notify`（主实例 / `when: blurred`；真实 toast 未做失焦自动化验证）；
- 官方订阅（OAuth）：`/standalone-ai/test` 返回 `ok:true`、`/whisper` 真实碎碎念成功、`/zen/go/v1/usage` 读到订阅用量；全程未导出任何 key；
- 复用 / 拉起 / 正常停 / 强杀 watchdog 兜底；
- 项目发现、`cli.json` 本地目录两种加载路径。

未完成 / 已知边界：

- **无 Node 环境**：standalone 需要 Node；后续可改用 Electron app 入口或打包 Node runtime。
- **与 DSH in-process 同时运行**：可能各起一只（standalone 的 runtime 文件只覆盖 standalone 形态）。
- **Web 浮层**：不做，OpenCode 无对应容器。
- **模型跟随是单宠物口径**：多会话不同模型时，宠物跟随最近活跃会话；不是每个会话一只。
- **provider 凭证来源**：优先 `opencode auth export`（多账号 per-provider；`type: "key"` 与 `type: "oauth"` 都认，后者是官方订阅的 `st_…`），回退 `auth.json` / 环境变量；export 不可用时用 `/pet-ai` 手动填。key 缓存 30s。
- **官方订阅经本机转接头**：`opencode-go` 等 `opencode` 系 provider 的 OAuth 凭证必须走回环代理补 `x-opencode-session`（见上），代理随 TUI 生命周期；`keepAlive=true` 时 TUI 全关后 AI 暂不可用。
- **模型同步最多 5s 延迟**；key 热更新最多 30s；`/pet-ai` 里改模型会被跟随逻辑覆盖，切模型请用 `/models`。
- **菜单裁剪依赖上游 `sprite.js` 结构**：上游大改时 `menu-patch.mjs` 会明确报错，需同步更新（契约测试会红）。

详细验证记录见 [`docs/VALIDATION.md`](docs/VALIDATION.md)。

## 开发

```sh
cd oc-pet
npm install
npm run typecheck
npm run verify
npm run spike:ocpet   # 起一次 TUI + 适配层，检查 daemon / 状态 / 清理
```

目录：

- `src/plugin-tui.ts` —— CLI 插件入口
- `src/daemon.ts` —— standalone 启停、runtime/租约、单例锁、主实例判定
- `src/events.ts` —— OpenCode 事件 → 6 档状态
- `src/work-status.ts` —— `/work-status` 客户端 + root/prefix HTTP 封装
- `src/commands.ts` —— `/pet*` 命令
- `src/ai.ts` —— 打开 standalone AI 设置页
- `src/model-sync.ts` —— 活跃会话模型 → standalone AI 设置（5s 同步）
- `src/opencode.ts` —— 只读 OpenCode auth/config（模型/凭证解析，API key 与 OAuth access 都认）
- `src/zen-proxy.ts` —— 官方订阅 OAuth 的本机转接头（补 `x-opencode-session`）
- `src/balance.ts` —— 余额查询 + 档位动画 + 第三方菜单
- `src/notifier.ts` —— 系统通知（主实例 / 失焦）
- `src/menu-patch.mjs` —— 桌面右键菜单裁剪
- `src/watchdog.mjs` —— 强杀兜底
- `spike/` —— 一次性验证工程（不随包发布）

## License

MIT。上游 `dsh-pet` 也是 MIT；本仓库只通过 npm 依赖和运行时 UI 裁剪复用它，不复制其源码。
