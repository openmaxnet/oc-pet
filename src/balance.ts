import { commandCode } from "dsh-pet/src/host/balance/providers/commandcode.ts"
import { deepseekOfficial } from "dsh-pet/src/host/balance/providers/deepseek-official.ts"
import { opencodeGo } from "dsh-pet/src/host/balance/providers/opencode-go.ts"
import {
  balanceBubbleView,
  balanceEventIndex,
  balancePercent,
  decideBalanceNotice,
  toBalanceState,
} from "dsh-pet/src/shared/balance/index.ts"

import { sleep, type Logger } from "./config"
import { isPrimaryInstance } from "./daemon"
import { authKeyFor, refreshAuthExport } from "./opencode"
import type { PetHttp } from "./work-status"

interface ConfigEntry {
  pets?: Array<Record<string, unknown>>
  animations?: { events?: { balance?: string[] } }
  eventsRefreshSec?: { balance?: number }
}

interface PetRef {
  id: string
  pet: Record<string, unknown>
  entry: ConfigEntry
}

interface BalanceProviderLike {
  fetch: (args: { key: string; provider: string }) => Promise<unknown>
}

interface ModelRef {
  providerID?: string
  id?: string
}

export interface BalanceShowResult {
  ok: boolean
  text: string
  /** 自动刷新时因原因未变化而跳过 */
  skipped?: boolean
  message?: string
}

interface BalanceServiceDeps {
  home: string
  http: PetHttp
  logger: Logger
  /** 当前展示会话的模型；由 plugin-tui 组合 reducer.activeModel() + context.ui.model.current() */
  getModel: () => ModelRef | undefined
}

const MENU_OWNER = "oc-pet"
const MENU_LABEL = "查看余额"
const MENU_POLL_MS = 5_000
const LOCK_TTL_MS = 15_000
const BUBBLE_MS = 10_000

function pickPet(config: unknown): PetRef | undefined {
  if (!config || typeof config !== "object") return undefined
  for (const raw of Object.values(config as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as ConfigEntry
    if (!Array.isArray(entry.pets) || entry.pets.length === 0) continue
    const pet = entry.pets.find((item) => item && item.id === "main") ?? entry.pets[0]
    const id = pet && typeof pet.id === "string" ? pet.id : undefined
    if (id) return { id, pet, entry }
  }
  return undefined
}

function pickProvider(model: ModelRef | undefined): {
  providerID: string
  key?: string
  impl?: BalanceProviderLike
} {
  const providerID = model?.providerID ?? "cmdc-wen"
  const key =
    authKeyFor(providerID) ??
    (providerID.startsWith("opencode")
      ? process.env.OPENCODE_GO_API_KEY
      : providerID.startsWith("deepseek")
        ? process.env.DEEPSEEK_API_KEY
        : undefined)

  if (providerID === "commandcode" || providerID.startsWith("cmdc-")) {
    return { providerID, key, impl: commandCode as unknown as BalanceProviderLike }
  }
  if (providerID === "opencode-go") {
    return { providerID, key, impl: opencodeGo as unknown as BalanceProviderLike }
  }
  if (providerID.startsWith("deepseek")) {
    return { providerID, key, impl: deepseekOfficial as unknown as BalanceProviderLike }
  }
  return { providerID, key }
}

async function queryBalance(model: ModelRef | undefined): Promise<unknown> {
  await refreshAuthExport()
  const selected = pickProvider(model)
  if (!selected.key) {
    return {
      ok: false,
      provider: selected.providerID,
      reason: "credential-missing",
      message: `缺少 ${selected.providerID} 的余额查询凭证`,
    }
  }
  if (!selected.impl) {
    return { ok: false, provider: selected.providerID, reason: "unsupported" }
  }
  try {
    return await selected.impl.fetch({ key: selected.key, provider: selected.providerID })
  } catch (error) {
    return {
      ok: false,
      provider: selected.providerID,
      reason: "fetch-error",
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function textOf(state: ReturnType<typeof toBalanceState>): string {
  if (!state) return "余额数据无法解析"
  const rows = balanceBubbleView(state)
  const text = rows.map((row) => row.text).filter(Boolean).join("\n")
  return text || "余额查询没有返回内容"
}

function animationOf(state: ReturnType<typeof toBalanceState>, entry: ConfigEntry): string | undefined {
  if (!state || !state.ok) return undefined
  const percent = balancePercent(state)
  if (percent === undefined) return undefined
  const pool = entry.animations?.events?.balance
  if (!Array.isArray(pool) || pool.length === 0) return undefined
  return pool[balanceEventIndex(percent)] ?? pool[pool.length - 1]
}

export interface BalanceService {
  manual(): Promise<BalanceShowResult>
  dispose(): void
}

/**
 * 余额：host 的 /balance 在 standalone 下固定报 unsupported（agentDefaultModel=standalone），
 * 所以适配层自己取数 + 自己驱动：
 *   取 OpenCode 当前 provider 的 key → 复用上游 provider 的 fetch/解析 → 选档位动画 →
 *   /lock → /anim（余额动画）→ /broadcast（文本气泡，关闭碎碎念动画联动）→ 10s 后放锁。
 * 桌面右键「查看余额」已从内置菜单移除，改由第三方菜单项「更多 → 查看余额」触发同一套逻辑。
 */
export function createBalanceService(deps: BalanceServiceDeps): BalanceService {
  const { home, http, logger, getModel } = deps
  let disposed = false
  let menuRegistered = false
  let lastNoticeKey: string | null = null
  let lastAuto = 0
  let autoTimer: ReturnType<typeof setInterval> | undefined
  let firstTimer: ReturnType<typeof setTimeout> | undefined
  let showing = false

  async function registerMenu(): Promise<void> {
    if (menuRegistered || disposed) return
    try {
      const result = await http.postJson<{ ok?: boolean; reason?: string; message?: string }>("menu/item", {
        owner: MENU_OWNER,
        labels: [MENU_LABEL],
      })
      if (result?.ok === false) {
        logger.warn(`注册余额菜单项失败：${result.reason ?? result.message ?? "unknown"}`)
        return
      }
      menuRegistered = true
      logger.info("已注册桌面菜单项：更多 → 查看余额")
    } catch (error) {
      logger.debug(`注册余额菜单项失败（下轮重试）：${String(error)}`)
    }
  }

  async function show(explicit: boolean): Promise<BalanceShowResult> {
    if (showing) return { ok: false, text: "", skipped: true, message: "正在查询余额" }
    showing = true
    try {
      const config = await http.getJson<unknown>("config")
      const ref = pickPet(config)
      if (!ref) return { ok: false, text: "", message: "没有找到桌宠配置" }
      if (!explicit && ref.pet.balanceEnabled === false) {
        return { ok: false, text: "", skipped: true }
      }

      const raw = await queryBalance(getModel())
      const state = toBalanceState(raw)
      if (!state) return { ok: false, text: "余额数据无法解析" }

      if (!state.ok && !explicit) {
        const decision = decideBalanceNotice(state, lastNoticeKey, false)
        if (!decision.show) return { ok: false, text: "", skipped: true }
        lastNoticeKey = decision.key
      }
      if (state.ok) lastNoticeKey = null

      const text = textOf(state)
      const anim = animationOf(state, ref.entry)
      const petId = encodeURIComponent(ref.id)

      let lock: { ok?: boolean; lockId?: string; reason?: string; message?: string }
      try {
        lock = await http.postJson(`lock?pet=${petId}&surface=desktop`, { ttl: LOCK_TTL_MS })
      } catch (error) {
        return { ok: false, text, message: `拿不到桌宠锁：${String(error)}` }
      }
      if (!lock?.ok || !lock.lockId) {
        return { ok: false, text, message: lock?.message ?? lock?.reason ?? "桌宠正忙" }
      }

      if (anim) {
        try {
          const result = await http.postJson<{ ok?: boolean; reason?: string; message?: string }>(
            `anim?pet=${petId}&surface=desktop&lock=${encodeURIComponent(lock.lockId)}`,
            { name: anim },
          )
          if (result?.ok === false) {
            logger.warn(`余额动画点播失败：${result.reason ?? result.message ?? "unknown"}`)
          }
        } catch (error) {
          logger.warn(`余额动画点播失败：${String(error)}`)
        }
      }

      const broadcast = await http.postJson<{ ok?: boolean; reason?: string; message?: string }>(
        `broadcast?pet=${petId}&surface=desktop&lock=${encodeURIComponent(lock.lockId)}`,
        { text, anim: false, duration: BUBBLE_MS },
      )
      if (broadcast?.ok === false) {
        logger.warn(`余额气泡投喂失败：${broadcast.reason ?? broadcast.message ?? "unknown"}`)
      }

      const release = setTimeout(() => {
        void http
          .postJson(`lock/release?pet=${petId}`, { lockId: lock.lockId })
          .catch((error) => logger.debug(`释放余额锁失败（可能已被用户接管）：${String(error)}`))
      }, BUBBLE_MS)
      release.unref?.()

      logger.info(`余额刷新：${state.ok ? "ok" : state.reason}${anim ? ` anim=${anim}` : ""}`)
      return {
        ok: state.ok,
        text,
        message: state.ok ? undefined : state.message ?? state.reason,
      }
    } catch (error) {
      logger.warn(`余额刷新失败：${String(error)}`)
      return { ok: false, text: "", message: error instanceof Error ? error.message : String(error) }
    } finally {
      showing = false
    }
  }

  async function autoTick(): Promise<void> {
    if (disposed || !isPrimaryInstance(home)) return
    try {
      const config = await http.getJson<{ main?: ConfigEntry }>("config")
      const intervalSec = config?.main?.eventsRefreshSec?.balance ?? 1800
      const intervalMs = Math.max(60, intervalSec) * 1000
      if (Date.now() - lastAuto < intervalMs) return
      lastAuto = Date.now()
    } catch {
      if (Date.now() - lastAuto < 1800 * 1000) return
      lastAuto = Date.now()
    }
    await registerMenu()
    await show(false)
  }

  async function pollMenu(): Promise<void> {
    while (!disposed) {
      if (!isPrimaryInstance(home)) {
        await sleep(2000)
        continue
      }
      await registerMenu()
      try {
        const response = await http.getJson<{
          ok?: boolean
          events?: Record<string, string | null>
        }>(`menu/events?owner=${MENU_OWNER}&wait=${MENU_POLL_MS}`, MENU_POLL_MS + 2000)
        if (response?.ok && response.events?.[MENU_LABEL]) {
          void show(true)
        }
      } catch {
        await sleep(1500)
      }
    }
  }

  void registerMenu()
  void pollMenu()
  firstTimer = setTimeout(() => {
    if (!isPrimaryInstance(home)) return
    lastAuto = Date.now()
    void show(false)
  }, 20_000)
  firstTimer.unref?.()
  autoTimer = setInterval(() => {
    void autoTick()
  }, 60_000)
  autoTimer.unref?.()

  return {
    manual: () => show(true),
    dispose() {
      disposed = true
      if (firstTimer) clearTimeout(firstTimer)
      if (autoTimer) clearInterval(autoTimer)
      firstTimer = undefined
      autoTimer = undefined
    },
  }
}
