import type { Logger, ResolvedOptions } from "./config"
import { truncate } from "./config"
import type { PetRuntime } from "./daemon"

export type PetWorkState = "thinking" | "working" | "result" | "waiting" | "success" | "error"

export interface WorkSnapshot {
  state: PetWorkState
  task?: string
}

/**
 * 把工作状态写进 dsh-pet 的固定外部槽。
 *
 * 上游契约（API.md「工作状态（外部写入）」）：
 *   POST   /dsh-pet-7340/work-status  { state, task? }
 *   DELETE /dsh-pet-7340/work-status
 * 所有 POST/DELETE 都需要 runtime 文件里的 token。
 */
export class WorkStatusClient {
  private current: WorkSnapshot | null = null
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly runtime: PetRuntime,
    private readonly options: ResolvedOptions,
    private readonly logger: Logger,
  ) {}

  private get base(): string {
    return `http://127.0.0.1:${this.runtime.port}/dsh-pet-7340`
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn).catch((error) => {
      this.logger.warn(`work-status 请求失败：${String(error)}`)
    })
    return this.chain
  }

  set(state: PetWorkState, task?: string): Promise<void> {
    const next: WorkSnapshot = task ? { state, task: truncate(task, 40) } : { state }
    if (this.current && this.current.state === next.state && this.current.task === next.task) {
      return this.chain
    }
    return this.enqueue(async () => {
      const response = await fetch(`${this.base}/work-status`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dsh-pet-token": this.runtime.token,
        },
        body: JSON.stringify(next),
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${await response.text().catch(() => "")}`.trim())
      }
      this.current = next
      this.logger.debug(`work-status -> ${state}${task ? ` (${task})` : ""}`)
    })
  }

  clear(force = false): Promise<void> {
    if (!force && this.current === null) return this.chain
    return this.enqueue(async () => {
      const response = await fetch(`${this.base}/work-status`, {
        method: "DELETE",
        headers: { "x-dsh-pet-token": this.runtime.token },
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok && response.status !== 204) {
        throw new Error(`HTTP ${response.status} ${await response.text().catch(() => "")}`.trim())
      }
      this.current = null
      this.logger.debug("work-status -> idle")
    })
  }
}

/** GET/POST 的轻量封装：命令和状态页共用。 */
export class PetHttp {
  constructor(private readonly runtime: PetRuntime) {}

  private get base(): string {
    return `http://127.0.0.1:${this.runtime.port}/dsh-pet-7340`
  }

  async getJson<T>(path: string, timeoutMs = 3000): Promise<T> {
    const response = await fetch(`${this.base}/${path}`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as T
  }

  async postJson<T>(path: string, body: unknown, timeoutMs = 3000): Promise<T> {
    const response = await fetch(`${this.base}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dsh-pet-token": this.runtime.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text().catch(() => "")}`.trim())
    return (await response.json().catch(() => ({}))) as T
  }
}

/** standalone 根路径（/standalone-ai/*、/shutdown 等），不在 /dsh-pet-7340 前缀下。 */
export class RootHttp {
  constructor(private readonly runtime: PetRuntime) {}

  private url(path: string): string {
    return `http://127.0.0.1:${this.runtime.port}/${path.replace(/^\/+/, "")}`
  }

  async getJson<T>(path: string, timeoutMs = 3000): Promise<T> {
    const response = await fetch(this.url(path), {
      headers: { "x-dsh-pet-token": this.runtime.token },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as T
  }

  async postJson<T>(path: string, body: unknown, timeoutMs = 10_000): Promise<T> {
    const response = await fetch(this.url(path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dsh-pet-token": this.runtime.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text().catch(() => "")}`.trim())
    return (await response.json().catch(() => ({}))) as T
  }
}
