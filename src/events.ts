import { truncate } from "./config"
import type { PetWorkState, WorkSnapshot } from "./work-status"

/**
 * OpenCode 事件 → dsh-pet 的 6 档工作状态。
 *
 * 档位顺序与上游 `animations.events.workStatus` 严格一致：
 *   thinking / working / result / waiting / success / error
 *
 * 事件名来自真实事件流（opencode 2.1.3 实测）：
 *   session.execution.started/succeeded/failed/interrupted
 *   session.step.started/ended/failed
 *   session.tool.input.started/ended、session.tool.called/progress/success/failed
 *   session.reasoning.* / session.text.* / permission.asked / session.compaction.*
 */

interface SessionState {
  state: PetWorkState
  task?: string
  updatedAt: number
  /** 进入终态的时间（用于在多个终态里挑最新的一个） */
  terminalAt?: number
  /** 终态过期时间（到时从 map 里删掉） */
  terminalExpiresAt?: number
  /** 这个会话最近一次实际使用的模型（来自 session.step.started / session.model.selected） */
  providerID?: string
  modelID?: string
}

const SUCCESS_TTL_MS = 8_000
const ERROR_TTL_MS = 12_000
const STALE_ACTIVE_MS = 5 * 60_000

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function modelFrom(value: unknown): { providerID?: string; id?: string } {
  if (!value || typeof value !== "object") return {}
  const model = value as Record<string, unknown>
  return {
    providerID: str(model.providerID) ?? str(model.provider),
    id: str(model.id) ?? str(model.model) ?? str(model.modelID),
  }
}

function eventParts(event: unknown): { type?: string; data: Record<string, unknown>; sessionID?: string } {
  const details = (event as { details?: Record<string, unknown> })?.details
  const root = details && typeof details === "object" ? details : (event as Record<string, unknown>)
  const type = str(root?.type)
  const rawData = root?.data
  const data = rawData && typeof rawData === "object" ? (rawData as Record<string, unknown>) : root
  let sessionID = str(data?.sessionID)
  if (!sessionID && data?.info && typeof data.info === "object") {
    sessionID = str((data.info as Record<string, unknown>).sessionID)
  }
  if (!sessionID) sessionID = str(root?.sessionID)
  // 某些事件（permission.asked 等）只在 envelope 上带 aggregateID
  if (!sessionID) sessionID = str(root?.aggregateID)
  return { type, data, sessionID }
}

function summarizeTool(name: string | undefined, input: unknown): string | undefined {
  const tool = (name ?? "").toLowerCase()
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === "string" && value.trim()) return value
    }
    return undefined
  }
  let detail: string | undefined
  if (tool === "shell" || tool === "bash" || tool === "execute") detail = pick("command", "cmd", "code")
  else if (tool === "read" || tool === "write" || tool === "edit" || tool === "multiedit" || tool === "patch")
    detail = pick("filePath", "path", "file")
  else if (tool === "grep" || tool === "glob" || tool === "search") detail = pick("pattern", "query")
  else if (tool === "webfetch" || tool === "fetch") detail = pick("url")
  else if (tool === "task") detail = pick("description", "prompt")
  else if (tool === "todo") return "更新任务清单"
  detail = detail ?? pick("description", "command", "path", "pattern", "url")
  if (!detail) return name ? `调用 ${name}` : undefined
  return truncate(`${name ? `${name}: ` : ""}${detail}`, 40)
}

function errorText(error: unknown): string | undefined {
  if (!error) return undefined
  if (typeof error === "string") return truncate(error, 40)
  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return truncate(message, 40)
    const type = (error as { type?: unknown }).type
    if (typeof type === "string") return truncate(type, 40)
  }
  return undefined
}

export class WorkStatusReducer {
  private readonly sessions = new Map<string, SessionState>()
  private readonly toolNames = new Map<string, string>()

  /** 返回 true = 可见快照可能变了，调用方可以立即 flush。 */
  handle(event: unknown): boolean {
    const { type, data, sessionID } = eventParts(event)
    if (!type || !sessionID) return false
    const now = Date.now()
    const session = this.sessions.get(sessionID) ?? { state: "thinking" as PetWorkState, updatedAt: now }
    this.sessions.set(sessionID, session)

    const touch = (): void => {
      session.updatedAt = now
    }
    const set = (state: PetWorkState, task?: string): boolean => {
      touch()
      session.terminalAt = undefined
      session.terminalExpiresAt = undefined
      const changed = session.state !== state || (task !== undefined && session.task !== task)
      session.state = state
      if (task !== undefined) session.task = task
      return changed
    }
    const terminal = (state: PetWorkState, task: string | undefined, ttl: number): boolean => {
      touch()
      session.state = state
      if (task !== undefined) session.task = task
      session.terminalAt = now
      session.terminalExpiresAt = now + ttl
      return true
    }

    switch (type) {
      case "session.created":
        this.sessions.set(sessionID, { state: "thinking", updatedAt: now })
        return false

      case "session.inbox.enqueued":
      case "session.inbox.delivered":
      case "session.execution.started":
        session.task = undefined
        return set("thinking")

      case "session.step.started": {
        const model = modelFrom(data.model)
        if (model.providerID) session.providerID = model.providerID
        if (model.id) session.modelID = model.id
        return set("thinking")
      }

      case "session.reasoning.started":
      case "session.text.started":
        return set("thinking")

      case "session.model.selected": {
        const model = modelFrom(data.model ?? data)
        if (model.providerID) session.providerID = model.providerID
        if (model.id) session.modelID = model.id
        touch()
        return false
      }

      case "session.tool.input.started": {
        const callID = str(data.id)
        const name = str(data.name)
        if (callID && name) this.toolNames.set(callID, name)
        return set("working", name ? summarizeTool(name, undefined) : undefined)
      }

      case "session.tool.input.ended":
      case "session.tool.progress":
        return set("working")

      case "session.tool.called": {
        const callID = str(data.id)
        const name = callID ? this.toolNames.get(callID) : undefined
        return set("working", summarizeTool(name, data.input))
      }

      case "session.tool.success": {
        const callID = str(data.id)
        const name = callID ? this.toolNames.get(callID) : undefined
        if (callID) this.toolNames.delete(callID)
        return set("result", name ? `${name} 完成` : "工具执行完成")
      }

      case "session.tool.failed": {
        const callID = str(data.id)
        if (callID) this.toolNames.delete(callID)
        return set("result", errorText(data.error) ? `工具失败：${errorText(data.error)}` : "工具执行失败")
      }

      case "session.step.ended": {
        const finish = str(data.finish) ?? str(data.rawFinish)
        return finish === "tool-calls" || finish === "tool_calls" ? set("result") : false
      }

      case "session.step.failed":
        return set("error", errorText(data.error) ?? "这一步没有跑通")

      case "session.execution.succeeded":
        return terminal("success", "任务完成", SUCCESS_TTL_MS)

      case "session.execution.failed":
        return terminal("error", errorText(data.error) ?? "执行失败", ERROR_TTL_MS)

      case "session.execution.interrupted":
        return terminal("error", "已中断", ERROR_TTL_MS)

      case "session.compaction.started":
        return set("working", "整理上下文")

      case "session.compaction.ended":
        return set("result", "上下文整理完成")

      case "session.compaction.failed":
        return set("error", "上下文整理失败")

      case "permission.asked":
        return set("waiting", str(data.title) ?? str(data.permission) ?? "等待你确认")

      case "permission.replied":
      case "permission.rejected":
        return set("thinking")

      case "shell.created":
        return set("working", summarizeTool("shell", data.info))

      case "shell.exited":
        return set("result", "命令执行完成")

      // 高频流式事件：只刷新活跃时间，不改变档位，也不触发 flush
      case "session.reasoning.delta":
      case "session.text.delta":
      case "session.usage.updated":
      case "session.instructions.updated":
      case "session.title.generate":
      case "session.title.pending":
      case "session.message.part.updated":
      case "session.message.part.delta":
        touch()
        return false

      default:
        touch()
        return false
    }
  }

  /** 清掉过期/停滞的会话；返回是否有删除。 */
  prune(now = Date.now()): boolean {
    let changed = false
    for (const [sessionID, session] of this.sessions) {
      if (session.terminalExpiresAt !== undefined) {
        if (now >= session.terminalExpiresAt) {
          this.sessions.delete(sessionID)
          changed = true
        }
        continue
      }
      if (now - session.updatedAt > STALE_ACTIVE_MS) {
        this.sessions.delete(sessionID)
        changed = true
      }
    }
    if (this.toolNames.size > 500) this.toolNames.clear()
    return changed
  }

  /** 当前应该展示的那条会话：优先活跃会话，其次还没到期的终态。 */
  private choose(): SessionState | undefined {
    let active: SessionState | undefined
    let finished: SessionState | undefined
    for (const session of this.sessions.values()) {
      if (session.terminalExpiresAt !== undefined) {
        if (!finished || (session.terminalAt ?? 0) > (finished.terminalAt ?? 0)) finished = session
        continue
      }
      if (!active || session.updatedAt > active.updatedAt) active = session
    }
    return active ?? finished
  }

  /** 当前应该展示的快照：优先活跃会话，其次还没到期的终态。 */
  snapshot(now = Date.now()): WorkSnapshot | null {
    this.prune(now)
    const chosen = this.choose()
    if (!chosen) return null
    return chosen.task ? { state: chosen.state, task: chosen.task } : { state: chosen.state }
  }

  /**
   * 当前展示会话最近使用的模型。
   * 多会话不同模型时，宠物跟随「它正在展示的那条会话」，而不是某个固定 TUI。
   * 没有活跃/终态会话时返回 undefined（调用方回落到 TUI 当前模型）。
   */
  activeModel(now = Date.now()): { providerID: string; id: string } | undefined {
    this.prune(now)
    const chosen = this.choose()
    if (!chosen?.providerID || !chosen.modelID) return undefined
    return { providerID: chosen.providerID, id: chosen.modelID }
  }

  get sessionCount(): number {
    return this.sessions.size
  }
}
