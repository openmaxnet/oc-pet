import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** 插件选项：全部可省略，默认值面向「开 TUI 就出现、关最后一个 TUI 就收起」。 */
export interface OcPetOptions {
  /** dsh-pet 数据根；默认 $DSH_HOME 或 ~/.dsh。 */
  dshHome?: string
  /** 固定 standalone 端口；不传则让上游从 3080 起顺延。 */
  port?: number
  /** TUI 全关后保留桌宠（不调 /shutdown）。 */
  keepAlive?: boolean
  /** 关掉工作状态联动，只保留桌宠本体。 */
  workStatus?: boolean
  /** 写详细日志到 $DSH_HOME/dsh-pet/opencode-adapter.log。 */
  debug?: boolean
  /** 日志里记录每次事件类型（排查映射用）。 */
  traceEvents?: boolean
}

export interface ResolvedOptions extends Required<Pick<OcPetOptions, "keepAlive" | "workStatus" | "debug" | "traceEvents">> {
  home: string
  port?: number
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function asPort(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined
}

export function resolveOptions(raw: unknown, env: NodeJS.ProcessEnv = process.env): ResolvedOptions {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const home =
    (typeof input.dshHome === "string" && input.dshHome.trim()) ||
    (typeof env.DSH_HOME === "string" && env.DSH_HOME.trim()) ||
    join(homedir(), ".dsh")
  return {
    home,
    port: asPort(input.port),
    keepAlive: asBoolean(input.keepAlive, false),
    workStatus: asBoolean(input.workStatus, true),
    debug: asBoolean(input.debug, false),
    traceEvents: asBoolean(input.traceEvents, false),
  }
}

export function petDataDir(home: string): string {
  return join(home, "dsh-pet")
}

export function runtimeFile(home: string): string {
  return join(petDataDir(home), "standalone-runtime.json")
}

export function leaseFile(home: string): string {
  return join(petDataDir(home), "opencode-leases.json")
}

export function lockFile(home: string): string {
  return join(petDataDir(home), "opencode-daemon.lock")
}

export function logFile(home: string): string {
  return join(petDataDir(home), "opencode-adapter.log")
}

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const MAX_LOG_BYTES = 1024 * 1024

/** 文件日志：TUI 里不能随便 console.log（会污染界面），所以默认只落盘。 */
export function createLogger(options: ResolvedOptions): Logger {
  const file = logFile(options.home)
  let lastSizeCheck = 0
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch {
    // 目录不可写时退化成内存日志：不让插件因为日志挂掉
  }
  const write = (level: string, message: string): void => {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`
    try {
      appendFileSync(file, line)
      const now = Date.now()
      if (now - lastSizeCheck > 60_000) {
        lastSizeCheck = now
        try {
          if (statSync(file).size > MAX_LOG_BYTES) truncateSync(file, 0)
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  return {
    debug(message) {
      if (options.debug) write("debug", message)
    },
    info(message) {
      write("info", message)
    },
    warn(message) {
      write("warn", message)
      console.error(`[oc-pet] ${message}`)
    },
    error(message) {
      write("error", message)
      console.error(`[oc-pet] ${message}`)
    },
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function truncate(text: string, max = 40): string {
  const clean = text.replace(/\s+/g, " ").trim()
  const points = Array.from(clean)
  return points.length <= max ? clean : `${points.slice(0, max - 1).join("")}…`
}
