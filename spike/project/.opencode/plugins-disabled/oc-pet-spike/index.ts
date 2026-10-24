// 验证用 server 插件：只记录「server 侧有没有加载我」，不碰任何真实业务。
import { appendFileSync } from "node:fs"

const out = process.env.OC_PET_SPIKE_OUT ?? ""

function record(event: Record<string, unknown>): void {
  if (!out) return
  appendFileSync(
    out,
    JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      side: "server",
      ...event,
    }) + "\n",
  )
}

export default {
  id: "oc-pet-spike",
  setup() {
    record({
      phase: "setup",
      argv: process.argv,
      cwd: process.cwd(),
      versions: process.versions,
      hasSpawn: typeof (globalThis as { Bun?: unknown }).Bun !== "undefined",
    })
    return () => record({ phase: "cleanup" })
  },
}
