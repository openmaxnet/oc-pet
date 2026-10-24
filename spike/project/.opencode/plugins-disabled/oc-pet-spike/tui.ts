// 验证用 CLI/TUI 插件：
//   1) setup 是否在启动 TUI 时执行；
//   2) 运行时到底是不是 Node/Bun（有没有 child_process / fs）；
//   3) 能否拉起并回收子进程；
//   4) TUI 正常退出时 cleanup 是否执行。
// 全部结果写进 OC_PET_SPIKE_OUT 指向的 JSONL，不依赖终端输出。
import { appendFileSync } from "node:fs"
import { spawn } from "node:child_process"

const out = process.env.OC_PET_SPIKE_OUT ?? ""

function record(event: Record<string, unknown>): void {
  if (!out) return
  appendFileSync(
    out,
    JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      side: "tui",
      ...event,
    }) + "\n",
  )
}

async function run(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.once("error", (error) => resolve({ code: null, stdout, stderr: stderr + String(error) }))
    child.once("exit", (code) => resolve({ code, stdout, stderr }))
  })
}

export default {
  id: "oc-pet-spike",
  async setup(context: unknown) {
    record({
      phase: "setup",
      argv: process.argv,
      cwd: process.cwd(),
      execPath: process.execPath,
      versions: process.versions,
      hasSpawn: typeof spawn === "function",
      hasBun: typeof (globalThis as { Bun?: unknown }).Bun !== "undefined",
      contextKeys: context && typeof context === "object" ? Object.keys(context as object).slice(0, 40) : [],
    })

    // 1) 普通命令：验证 PATH 里的 node 能否被拉起
    const nodeVersion = await run("node", ["--version"])
    record({ phase: "spawn-node", ...nodeVersion })

    // 2) 自身可执行文件：Bun 单文件产物用 --version 是安全的
    const selfVersion = await run(process.execPath, ["--version"])
    record({ phase: "spawn-self", ...selfVersion })

    // 3) 写文件：验证插件是否拥有真实文件系统权限
    try {
      appendFileSync(out + ".fs-ok", "ok\n")
      record({ phase: "fs-ok" })
    } catch (error) {
      record({ phase: "fs-error", message: String(error) })
    }

    // 4) 事件流：记录会话事件类型，验证能否映射成工作状态
    let eventCount = 0
    let stopListen: (() => void) | undefined
    try {
      const data = (context as { data?: { listen?: (fn: (event: unknown) => void) => () => void } }).data
      if (typeof data?.listen === "function") {
        stopListen = data.listen((event) => {
          if (eventCount >= 60) return
          eventCount += 1
          const details = (event as { details?: Record<string, unknown> })?.details
          record({
            phase: "event",
            n: eventCount,
            type: (details?.type as string) ?? (event as { type?: string })?.type ?? "unknown",
            topKeys: event && typeof event === "object" ? Object.keys(event as object).slice(0, 12) : [],
            detailKeys: details && typeof details === "object" ? Object.keys(details).slice(0, 24) : [],
            sessionID: typeof details?.sessionID === "string" ? details.sessionID : undefined,
            messageID: typeof details?.messageID === "string" ? details.messageID : undefined,
            tool: typeof details?.tool === "string" ? details.tool : undefined,
            status: typeof details?.status === "string" ? details.status : undefined,
            locationKeys:
              details?.location && typeof details.location === "object"
                ? Object.keys(details.location as object).slice(0, 12)
                : [],
            dataKeys:
              details?.data && typeof details.data === "object"
                ? Object.keys(details.data as object).slice(0, 20)
                : [],
            dataPreview:
              details?.data && typeof details.data === "object"
                ? JSON.stringify(details.data).slice(0, 300)
                : undefined,
          })
        })
        record({ phase: "listen-ok" })
      } else {
        record({ phase: "listen-missing", dataKeys: data && typeof data === "object" ? Object.keys(data) : [] })
      }
    } catch (error) {
      record({ phase: "listen-error", message: String(error) })
    }

    return () => {
      try {
        stopListen?.()
      } catch (error) {
        record({ phase: "listen-stop-error", message: String(error) })
      }
      record({ phase: "cleanup" })
    }
  },
}
// reload-test 2026-10-24T16:01:32.7561408+08:00
