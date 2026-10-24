/**
 * OpenCode CLI/TUI 插件入口（package.json 的 exports["./tui"]）。
 *
 * 生命周期：
 *   启动 TUI → setup → 裁菜单 → 确保 standalone daemon → 配置 AI → 订阅事件
 *   正常退出/插件重载 → cleanup → 清空工作状态 → 最后一个 TUI 退出时停 daemon
 *
 * 设计约束：不 import 上游 dsh-pet 的 JS 入口（它依赖三个 DSH 私有包），
 * 只把它当 npm 包里的一支 CLI + 本地 HTTP 服务来用。
 */
import { join } from "node:path"

import { createLogger, resolveOptions } from "./config"
import {
  addLease,
  ensureDaemon,
  ensureDataDir,
  isPrimaryInstance,
  releaseLease,
  resolveUpstreamRoot,
  stopDaemon,
  type PetRuntime,
} from "./daemon"
import { WorkStatusReducer } from "./events"
import { PetHttp, RootHttp, WorkStatusClient } from "./work-status"
import { registerPetCommands } from "./commands"
import { cleanupOldWatchdog, startWatchdog } from "./watchdog"
import { applyMenuPatch } from "./menu-patch.mjs"
import { openAiSettings as openAiSettingsPage } from "./ai"
import { createModelSync } from "./model-sync"
import { currentModel } from "./opencode"
import { Notifier } from "./notifier"
import { createBalanceService } from "./balance"

interface PluginContext {
  options?: unknown
  app?: { version?: string }
  location?: { directory?: string }
  data?: {
    listen?: (fn: (event: unknown) => void) => () => void
    on?: (name: string, fn: (event: unknown) => void) => () => void
    session?: { get?: (sessionID: string) => { title?: string } | undefined }
  }
  ui?: {
    toast?: { show?: (input: { message: string; variant?: string; title?: string; duration?: number }) => void }
    model?: { current?: () => unknown }
  }
  attention?: {
    notify?: (input: {
      title?: string
      message: string
      notification?: { when?: "always" | "focused" | "blurred" }
    }) => Promise<unknown>
  }
  keymap?: { layer?: (factory: () => unknown) => unknown }
}

function toast(context: PluginContext, message: string, variant: "info" | "success" | "error" = "info"): void {
  try {
    context.ui?.toast?.show?.({ message, variant })
  } catch {
    // ignore
  }
}

function listenAll(context: PluginContext, fn: (event: unknown) => void): () => void {
  const data = context.data
  if (typeof data?.listen === "function") return data.listen(fn)
  if (typeof data?.on === "function") {
    // 兜底：没有 listen 时订阅关键事件（旧版本兼容）
    const events = [
      "session.execution.started",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.step.started",
      "session.step.ended",
      "session.step.failed",
      "session.tool.called",
      "session.tool.success",
      "session.tool.failed",
      "permission.asked",
      "session.compaction.failed",
    ]
    const stops = events.map((name) => data.on!(name, fn))
    return () => stops.forEach((stop) => stop())
  }
  return () => {}
}

async function firstPetId(http: PetHttp): Promise<string | undefined> {
  try {
    const config = await http.getJson<Record<string, { pets?: Array<{ id?: unknown }> }>>("config")
    for (const entry of Object.values(config ?? {})) {
      const pets = entry?.pets
      if (!Array.isArray(pets) || pets.length === 0) continue
      const main = pets.find((pet) => pet?.id === "main") ?? pets[0]
      if (typeof main?.id === "string" && main.id) return main.id
    }
  } catch {
    // ignore
  }
  return undefined
}

interface AiReply {
  ok: boolean
  text: string
  message?: string
}

export default {
  id: "oc-pet",
  async setup(rawContext: unknown): Promise<() => void> {
    const context = rawContext as PluginContext
    const options = resolveOptions(context.options)
    const logger = createLogger(options)
    logger.info(
      `setup: oc-pet@0.0.3 opencode=${context.app?.version ?? "?"} ` +
        `cwd=${context.location?.directory ?? process.cwd()} home=${options.home} keepAlive=${options.keepAlive}`,
    )
    ensureDataDir(options.home)

    // 1) 桌面菜单裁剪：OpenCode 不需要「打开网站 / 显示位置」，内置「查看余额」改走第三方菜单
    const spriteFile = join(resolveUpstreamRoot(), "runtime", "electron-helper", "sprite.js")
    const patch = applyMenuPatch(spriteFile)
    if (!patch.ok) logger.warn(`桌面菜单裁剪失败：${patch.reason ?? "unknown"}`)
    else if (patch.applied) logger.info("桌面菜单已裁剪：移除 打开网站 / 查看余额 / 显示位置")

    // 2) daemon
    let runtime: PetRuntime
    let spawned = false
    try {
      const ensured = await ensureDaemon(options, logger)
      runtime = ensured.runtime
      spawned = ensured.spawned
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`桌宠启动失败：${message}`)
      toast(context, `桌宠启动失败：${message}`, "error")
      return () => {}
    }

    const http = new PetHttp(runtime)
    if (patch.applied && !spawned) {
      // 已经在跑的 helper 仍是旧菜单：请宿主重启 helper 让 patch 生效
      try {
        await http.postJson("reload", {})
        logger.info("已请求桌面 Helper 重载（菜单裁剪生效）")
      } catch (error) {
        logger.warn(`重载 Helper 失败（菜单裁剪将在下次启动生效）：${String(error)}`)
      }
    }

    const sessions = addLease(options.home, spawned)
    logger.info(`daemon pid=${runtime.pid} port=${runtime.port} spawned=${spawned} sessions=${sessions}`)

    // 3) 强杀兜底
    cleanupOldWatchdog(options.home, logger)
    startWatchdog(options, runtime, logger)

    // 4) 模型跟随：主实例每 5s 对比 OpenCode 当前活跃会话的模型 + standalone AI 设置
    const client = new WorkStatusClient(runtime, options, logger)
    const reducer = new WorkStatusReducer()
    const rootHttp = new RootHttp(runtime)
    const modelSync = createModelSync({
      context,
      home: options.home,
      runtime,
      root: rootHttp,
      reducer,
      logger,
    })
    const notifier = new Notifier(context, options.home, logger)
    const balance = createBalanceService({
      home: options.home,
      http,
      logger,
      getModel: () => reducer.activeModel() ?? currentModel(context),
    })
    try {
      await modelSync.start()
    } catch (error) {
      logger.warn(`模型跟随启动失败：${String(error)}`)
    }
    let stopped = false
    let daemonStopped = false
    let timer: ReturnType<typeof setInterval> | undefined
    let stopListen: (() => void) | undefined
    let disposeCommands: (() => void) | undefined

    const flush = (): void => {
      if (stopped || daemonStopped) return
      const snapshot = reducer.snapshot(Date.now())
      if (snapshot) void client.set(snapshot.state, snapshot.task)
      else void client.clear()
    }

    if (options.workStatus) {
      // 只有在没有其他 TUI 共用时才清空外部槽，避免抢掉别人的状态
      if (sessions === 1) void client.clear(true)
    }
    try {
      stopListen = listenAll(context, (event) => {
        if (stopped) return
        if (options.traceEvents) {
          const details = (event as { details?: { type?: string } })?.details
          logger.debug(`event: ${details?.type ?? "unknown"}`)
        }
        // 通知不依赖 workStatus 开关：即使关了档位联动，系统通知仍然工作
        notifier.handle(event)
        if (options.workStatus && reducer.handle(event)) flush()
      })
    } catch (error) {
      logger.warn(`事件订阅失败：${String(error)}`)
    }
    if (options.workStatus) {
      timer = setInterval(() => {
        if (stopped) return
        if (reducer.prune(Date.now())) flush()
      }, 2000)
      timer.unref?.()
    }

    // 5) 碎碎念 / 对话：走 host 的 /whisper、/chat（AI 已由 standalone 设置提供）
    const whisper = async (): Promise<AiReply> => {
      const pet = await firstPetId(http)
      if (!pet) return { ok: false, text: "", message: "没有找到桌宠" }
      try {
        const result = await http.postJson<{ ok?: boolean; text?: string; reason?: string; message?: string }>(
          `whisper?pet=${encodeURIComponent(pet)}&surface=desktop`,
          {},
          45_000,
        )
        return {
          ok: result?.ok === true,
          text: typeof result?.text === "string" ? result.text : "",
          message: result?.message ?? result?.reason,
        }
      } catch (error) {
        return { ok: false, text: "", message: error instanceof Error ? error.message : String(error) }
      }
    }

    const chat = async (text: string): Promise<AiReply> => {
      const pet = await firstPetId(http)
      if (!pet) return { ok: false, text: "", message: "没有找到桌宠" }
      try {
        const result = await http.postJson<{ ok?: boolean; text?: string; reason?: string; message?: string }>(
          `chat?pet=${encodeURIComponent(pet)}&surface=desktop`,
          { text },
          45_000,
        )
        return {
          ok: result?.ok === true,
          text: typeof result?.text === "string" ? result.text : "",
          message: result?.message ?? result?.reason,
        }
      } catch (error) {
        return { ok: false, text: "", message: error instanceof Error ? error.message : String(error) }
      }
    }

    disposeCommands = registerPetCommands(context, {
      http,
      runtime,
      logger,
      sessionCount: () => reducer.sessionCount,
      stop: async () => {
        // 只停 daemon，不设置 stopped：TUI 退出时仍要走正常的租约释放/清理
        daemonStopped = true
        balance.dispose()
        if (timer) clearInterval(timer)
        timer = undefined
        try {
          stopListen?.()
        } catch {
          // ignore
        }
        stopListen = undefined
        await client.clear(true)
        await stopDaemon(options.home, runtime, logger)
      },
      balance: () => balance.manual(),
      whisper,
      chat,
      openAiSettings: () => openAiSettingsPage(runtime, logger),
    })

    return async (): Promise<void> => {
      if (stopped) return
      stopped = true
      balance.dispose()
      modelSync.dispose()
      if (timer) clearInterval(timer)
      timer = undefined
      try {
        stopListen?.()
      } catch {
        // ignore
      }
      stopListen = undefined
      try {
        disposeCommands?.()
      } catch {
        // ignore
      }
      disposeCommands = undefined

      await client.clear(true)
      const shouldStop = releaseLease(options.home, logger)
      if (shouldStop && !options.keepAlive && !daemonStopped) {
        await stopDaemon(options.home, runtime, logger)
      } else {
        logger.info(
          shouldStop
            ? daemonStopped
              ? "daemon 已被 /pet-stop 停止"
              : "keepAlive=true，保留 daemon"
            : "还有其他 TUI / 手动 daemon，保留运行",
        )
      }
      logger.info("cleanup 完成")
    }
  },
}
