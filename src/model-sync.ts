import { createHash } from "node:crypto"

import type { Logger } from "./config"
import type { PetRuntime } from "./daemon"
import { isPrimaryInstance } from "./daemon"
import type { WorkStatusReducer } from "./events"
import { currentModel, refreshAuthExport, resolveAiConfigFor, type ResolvedAiConfig } from "./opencode"

interface RootClient {
  getJson<T>(path: string, timeoutMs?: number): Promise<T>
  postJson<T>(path: string, body: unknown, timeoutMs?: number): Promise<T>
}

interface AiSettings {
  enabled?: boolean
  hasKey?: boolean
  model?: string
  baseUrl?: string
  automaticWhispers?: boolean
  whisperIntervalSec?: number
  maxTokens?: number
  timeoutMs?: number
}

export interface ModelSyncDeps {
  context: unknown
  home: string
  runtime: PetRuntime
  root: RootClient
  reducer: WorkStatusReducer
  logger: Logger
  /** 测试注入；默认读 OpenCode 的 opencode.json + auth.json。 */
  resolve?: (providerID: string, modelID: string) => ResolvedAiConfig | undefined
}

export interface ModelSync {
  start(): Promise<void>
  syncOnce(): Promise<void>
  dispose(): void
}

function fingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8)
}

/**
 * 模型跟随：
 *   宠物是全局单实例，所以「它的脑子」跟随**它正在展示的那条会话**的模型
 *   （session.step.started / session.model.selected 记录在 reducer 里）；
 *   没有活跃/终态会话时，回落到当前 TUI 的 context.ui.model.current()。
 *
 * 主实例每 5s 读一次 OpenCode 配置/凭据并对比 standalone AI 设置：
 *   - 同一 endpoint、模型变化 → 只 patch model + apiKey（保留 baseUrl/其它设置）
 *   - endpoint 变化 → 整份更新（provider 切了）
 *   - 首次 / 没有 key → 整份写入并打开自动碎碎念
 * 这样多会话用不同模型时，宠物会跟着「当前展示的会话」切换；
 * OpenCode 配置热重载后，最迟 5s 跟上。
 */
export function createModelSync(deps: ModelSyncDeps): ModelSync {
  const { context, home, root, reducer, logger } = deps
  const resolve = deps.resolve ?? resolveAiConfigFor
  let disposed = false
  let started = false
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false
  let lastKey = ""
  let lastWarnKey = ""

  function desired(): { providerID: string; id: string } | undefined {
    const active = reducer.activeModel()
    if (active?.providerID && active.id) return active
    const current = currentModel(context)
    if (current?.providerID && current.id) return { providerID: current.providerID, id: current.id }
    return undefined
  }

  async function syncOnce(): Promise<void> {
    if (disposed || !isPrimaryInstance(home)) return
    if (running) return
    running = true
    try {
      const model = desired()
      if (!model) return
      await refreshAuthExport()

      const resolved = resolve(model.providerID, model.id)
      if (!resolved) {
        const warnKey = `${model.providerID}/${model.id}`
        if (warnKey !== lastWarnKey) {
          lastWarnKey = warnKey
          logger.warn(`当前会话模型 ${warnKey} 缺少 provider 配置/凭据，AI 暂不切换`)
        }
        return
      }

      const keyHash = fingerprint(resolved.apiKey)
      const key = `${resolved.providerID}|${resolved.model}|${resolved.baseUrl}|${keyHash}`
      if (key === lastKey) return

      let current: AiSettings | undefined
      try {
        current = await root.getJson<AiSettings>("standalone-ai/settings", 5000)
      } catch {
        current = undefined
      }

      const enabled = current?.enabled === true && current?.hasKey === true
      const sameEndpoint = enabled && current?.baseUrl === resolved.baseUrl
      const first = !enabled

      const body = sameEndpoint
        ? { model: resolved.model, apiKey: resolved.apiKey }
        : {
            protocol: resolved.protocol,
            baseUrl: resolved.baseUrl,
            model: resolved.model,
            apiKey: resolved.apiKey,
            enabled: true,
            automaticWhispers: first ? true : (current?.automaticWhispers ?? true),
            whisperIntervalSec: current?.whisperIntervalSec ?? 300,
            maxTokens: current?.maxTokens ?? 1024,
            timeoutMs: current?.timeoutMs ?? 30_000,
          }

      try {
        await root.postJson("standalone-ai/settings", body, 10_000)
        lastKey = key
        lastWarnKey = ""
        logger.info(
          `模型同步：${resolved.providerID}/${resolved.model}` +
            (resolved.oauth ? `（官方订阅 OAuth，经 ${resolved.baseUrl} 本机转接）` : ""),
        )
      } catch (error) {
        logger.warn(`模型同步失败（下轮重试）：${String(error)}`)
      }
    } finally {
      running = false
    }
  }

  return {
    async start() {
      if (started) return
      started = true
      await syncOnce()
      timer = setInterval(() => {
        void syncOnce()
      }, 5000)
      timer.unref?.()
    },
    syncOnce,
    dispose() {
      disposed = true
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}
