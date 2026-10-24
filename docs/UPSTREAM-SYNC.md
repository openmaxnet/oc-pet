# 上游同步策略

## 一句话

**不 fork 上游源码。** `dsh-pet` 只作为 npm 依赖 + 一支 standalone CLI + 本地 HTTP 服务消费；升级 = 换版本号 → 跑契约测试 → 通过才保留。唯一的“改文件”是**桌面右键菜单的运行时 UI 裁剪**（`src/menu-patch.mjs`，幂等，契约测试检查 marker）。

## 我们依赖的「公开面」

| 面 | 具体内容 | 稳定性 | 破坏时改哪里 |
| --- | --- | --- | --- |
| npm 包 | `dsh-pet@<exact>` | 高 | `package.json` |
| CLI | `node node_modules/dsh-pet/lib/standalone.js [--port]` | 高 | `src/daemon.ts` |
| runtime 文件 | `<DSH_HOME>/dsh-pet/standalone-runtime.json` 的 `pid` / `port` / `token` | 中 | `src/daemon.ts`、`src/watchdog.mjs` |
| HTTP（前缀） | `/config`、`/state`、`/work-status`、`/lock`、`/anim`、`/broadcast`、`/whisper`、`/chat`、`/menu/*`、`/pet-display`、`/reload` | 中 | `src/work-status.ts`、`src/balance.ts`、`src/commands.ts` |
| HTTP（根） | `/health`、`/standalone-ai/settings`、`/standalone-ai/test`、`/shutdown` | 中 | `src/ai.ts`、`src/daemon.ts` |
| 桌面菜单结构 | `runtime/electron-helper/sprite.js` 里的 `const tools` / `tools.push` / `S.displayMenuBranch()` | 低 | `src/menu-patch.mjs` |
| OpenCode 凭据/配置 | `~/.config/opencode/opencode.json`、`~/.local/share/opencode/auth.json`（只读） | 中 | `src/opencode.ts` |
| 事件 | 只用 OpenCode 自己的事件（不依赖上游） | — | `src/events.ts` |
| 素材/渲染 | 全部在上游包内，适配层不接触 | 高 | 无需改 |

**明确不 import**：`dsh-pet/lib/index.js`。它静态依赖 `@deepseek-ai/dsh-home-paths`、`dsh-credentials`、`dsh-llm` 三个 DSH 私有包，在 OpenCode 环境里不可解析。需要宿主半侧能力时，一律走 standalone CLI + HTTP。

## 升级流程

```sh
cd oc-pet

# 1. 看当前 / 最新
node scripts/sync-upstream.mjs --check

# 2. 先跑一遍当前版本的契约测试（基线）
node scripts/verify-upstream.mjs

# 3. 升级到指定版本（或 --latest）
node scripts/sync-upstream.mjs --apply 0.3.9

# 4. 失败会自动回滚；成功后 upstream.json 自动更新
```

`verify-upstream.mjs` 会：

1. 校验 `dsh-pet` 版本与 `upstream.json` 一致；
2. 校验我们实际用到的入口文件存在；
3. 应用/检查菜单裁剪补丁（marker + 三个移除项）；
4. 用临时 `DSH_HOME` + `display: web` 启动 standalone（不弹窗，但动作端点可用）；
5. 校验 runtime 文件字段；
6. 校验 `/health`、`/config`、`/state`、`/work-status` POST+DELETE；
7. 校验 `/lock` → `/anim` → `/broadcast` → `/lock/release`；
8. 校验 `/menu/item` 注册/查询/删除；
9. 校验 `/standalone-ai/settings`；
10. 校验 `/pet-display`、`/shutdown`；
11. 全部通过才返回 0。

## 菜单裁剪补丁

OpenCode 没有 DSH 的「网页端 / 打开软件 / 显示位置」，所以桌面 helper 的右键菜单需要裁掉三项：

- 打开网站 / 打开软件（`open-site`）
- 内置 查看余额（改由第三方菜单「更多 → 查看余额」承接）
- 显示位置（`displayMenuBranch`，网页/两者/都不在 OpenCode 无意义）

`src/menu-patch.mjs` 对 `runtime/electron-helper/sprite.js` 做**幂等字符串替换**：

- 有 marker（`oc-pet: menu trimmed for OpenCode`）就跳过；
- 找不到 `const tools` / `tools.push({ label: '查看余额'...` / `S.displayMenuBranch(),` 就返回明确 reason；
- 插件 setup 时在 `ensureDaemon` 之前应用；如果 daemon 已在跑，会 `POST /reload` 让 helper 重载；
- `verify-upstream.mjs` 也会应用并检查 marker，所以升级时如果上游改了菜单结构，契约测试会红。

修复方式：打开新版 `sprite.js` 的 `onContextMenu`，按新的字符串更新 `menu-patch.mjs` 的三个锚点；不要扩大成业务补丁。

## AI 配置 / 模型跟随

`src/opencode.ts` 只读 OpenCode 的：

- `opencode auth export`（多账号 per-provider key，缓存 30s；`cmdc-*` 用同名 provider，避免把 Wen 的 key 用到 Huan 上）
- `~/.config/opencode/opencode.json`（provider 的 `settings.baseURL`、模型 id）
- `~/.local/share/opencode/auth.json`（export 不可用时的回退）
- 环境变量 `OPENCODE_GO_API_KEY` / `DEEPSEEK_API_KEY`（最后回退）

`src/model-sync.ts` 由**主实例**每 5s 做一次同步：

- 目标模型 = `reducer.activeModel()`（宠物正在展示的那条会话，来自 `session.step.started` / `session.model.selected`）；
- 没有活跃/终态会话时，回落到主 TUI 的 `context.ui.model.current()`；
- 同一 endpoint 只换模型 → 只 patch `model + apiKey`；
- 换 provider/endpoint → 整份更新；
- 首次配置/没有 key → 整份写入并打开自动碎碎念；
- 读不到 provider 配置/凭据 → 保持上一份设置并写一次日志（不会让宠物哑掉）。

OpenCode 配置热重载后，这一轮同步会读到新的 `opencode.json` / `auth.json`，最迟 5s 后切到新模型。`/pet-ai` 页面主要用于 baseURL/密钥/自动碎碎念；**模型字段会被跟随逻辑覆盖**，切模型请用 `/models`。

单测在 `src/model-sync.test.ts`（首次全量、同模型不重复写、同 endpoint patch、换 endpoint 全量、无 key 只告警一次）。

## 契约变了怎么办

按顺序处理，**不要先改 `node_modules`**：

1. **先看失败项属于哪一层**（上表）。
2. **优先加兼容层**，不要重写业务：
   - runtime 文件字段改名 → `src/daemon.ts` 里做「新旧字段都认」；
   - HTTP 路径/字段变化 → `src/work-status.ts` / `src/balance.ts` / `src/commands.ts` 加适配；
   - standalone 参数变化 → `src/daemon.ts` 的 `spawnDaemon`；
   - 菜单结构变化 → `src/menu-patch.mjs` 的三个字符串锚点；
   - OpenCode 配置/凭据路径变化 → `src/opencode.ts` 的候选列表。
3. **事件映射不依赖上游**：OpenCode 事件变了才改 `src/events.ts`，与 `dsh-pet` 升级无关。
4. **确实需要上游补能力**（例如 runtime 文件不写 token、缺少某个端点）：
   - 首选给上游提 issue / PR；
   - 临时方案才用 `patches/` + `patch-package`，并在 `upstream.json` 记录对应 issue；
   - 补丁必须附带一条契约测试，否则下次升级会静默烂掉。

## 版本矩阵

| dsh-pet | opencode | Node | 结果 |
| --- | --- | --- | --- |
| 0.3.8 | 2.1.3 | 24.18.0 (win32-x64) | ✅ 已实测（2026-10-24） |

升级后把新行补进这张表；CI 至少覆盖一个 Windows + 一个 Linux。

## CI 建议

```yaml
- run: npm ci
- run: npm run verify
```

如果上游 `latest` 与 `package.json` 不一致，先开一个单独的分支跑 `--apply`，不要直接合并到主分支。

## 为什么不用 git submodule / 复制源码

- 上游包带 51.8 MB 动画素材和 106 个 webm；复制会双倍体积，还会让「素材更新」变成手工同步。
- npm 包已经包含 `lib/`、`src/`、`runtime/`、`assets/`，是完整的可分发包。
- 只用 CLI + HTTP + runtime 文件 + OpenCode 只读配置 + 一处菜单 UI 裁剪，上游内部怎么重构（React/Cordis/模块拆分）都不影响我们。
