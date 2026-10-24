import { spawn } from "node:child_process"

import type { Logger } from "./config"
import type { PetRuntime } from "./daemon"

/** 在系统浏览器打开上游的 AI 设置页（URL 里带本进程 token，不写日志）。 */
export function openAiSettings(runtime: PetRuntime, logger: Logger): boolean {
  const url =
    runtime.settingsUrl ??
    `http://127.0.0.1:${runtime.port}/standalone-ai/#token=${encodeURIComponent(runtime.token)}`
  try {
    if (process.platform === "win32") {
      const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
      child.unref()
    } else {
      const command = process.platform === "darwin" ? "open" : "xdg-open"
      const child = spawn(command, [url], { detached: true, stdio: "ignore" })
      child.unref()
    }
    return true
  } catch (error) {
    logger.warn(`打开 AI 设置页失败：${String(error)}`)
    return false
  }
}
