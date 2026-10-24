import type { Logger } from "./config"
import { isPrimaryInstance } from "./daemon"

interface PluginContext {
  data?: {
    session?: {
      get?: (sessionID: string) => { title?: string } | undefined
    }
  }
  attention?: {
    notify?: (input: {
      title?: string
      message: string
      notification?: { when?: "always" | "focused" | "blurred" }
    }) => Promise<unknown>
  }
}

const NOTIFY_TYPES = new Set([
  "permission.asked",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.compaction.failed",
])

function parts(event: unknown): { type?: string; sessionID?: string; message?: string } {
  const details = (event as { details?: Record<string, unknown> })?.details
  if (!details || typeof details !== "object") return {}
  const type = typeof details.type === "string" ? details.type : undefined
  const data =
    details.data && typeof details.data === "object"
      ? (details.data as Record<string, unknown>)
      : details
  const sessionID =
    typeof data.sessionID === "string"
      ? data.sessionID
      : typeof details.aggregateID === "string"
        ? details.aggregateID
        : undefined
  let message: string | undefined
  const error = data.error
  if (error && typeof error === "object") {
    const text = (error as { message?: unknown }).message
    if (typeof text === "string" && text) message = text
  }
  return { type, sessionID, message }
}

/**
 * 系统通知：只由「主实例」（租约里 PID 最小的 TUI）发，避免开三个 TUI 弹三次。
 * `when: "blurred"` —— 用户正盯着 TUI 时不打扰，切走后才弹系统通知。
 */
export class Notifier {
  private readonly last = new Map<string, number>()

  constructor(
    private readonly context: PluginContext,
    private readonly home: string,
    private readonly logger: Logger,
  ) {}

  handle(event: unknown): void {
    const { type, sessionID, message: errorText } = parts(event)
    if (!type || !NOTIFY_TYPES.has(type)) return
    if (!isPrimaryInstance(this.home)) return
    const key = `${type}:${sessionID ?? "unknown"}`
    const now = Date.now()
    if (now - (this.last.get(key) ?? 0) < 5_000) return
    this.last.set(key, now)

    let title = "OpenCode"
    let message = ""
    switch (type) {
      case "permission.asked":
        message = "需要你确认一个操作"
        break
      case "session.execution.succeeded":
        message = "任务完成"
        break
      case "session.execution.failed":
        message = errorText ? `执行失败：${errorText}` : "执行失败"
        break
      case "session.execution.interrupted":
        message = "执行已中断"
        break
      case "session.compaction.failed":
        message = "上下文整理失败"
        break
      default:
        return
    }

    // 会话标题只在拿得到时拼上；拿不到不编造
    try {
      const session = sessionID ? this.context.data?.session?.get?.(sessionID) : undefined
      if (session?.title) title = `OpenCode · ${session.title}`
    } catch {
      // ignore
    }

    try {
      const notify = this.context.attention?.notify
      if (typeof notify !== "function") return
      void notify.call(this.context.attention, {
        title,
        message,
        notification: { when: "blurred" },
      }).catch((error) => this.logger.debug(`系统通知失败：${String(error)}`))
    } catch (error) {
      this.logger.debug(`系统通知失败：${String(error)}`)
    }
  }
}
