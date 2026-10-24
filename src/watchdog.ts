import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { leaseFile, logFile, petDataDir, runtimeFile, type Logger, type ResolvedOptions } from "./config"
import { isPidAlive, type PetRuntime } from "./daemon"

function watchdogFiles(home: string): { spec: string; pid: string } {
  return {
    spec: join(petDataDir(home), `opencode-watchdog-${process.pid}.json`),
    pid: join(petDataDir(home), `opencode-watchdog-${process.pid}.pid`),
  }
}

function resolveWatchdogEntry(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "watchdog.mjs")
}

/** 插件重载时，同一个 TUI 进程会再次 setup：先把上一代 watchdog 收掉。 */
export function cleanupOldWatchdog(home: string, logger: Logger): void {
  const files = watchdogFiles(home)
  try {
    if (existsSync(files.pid)) {
      const pid = Number(readFileSync(files.pid, "utf8").trim())
      if (isPidAlive(pid)) {
        try {
          process.kill(pid)
          logger.debug(`结束上一代 watchdog pid=${pid}`)
        } catch {
          // ignore
        }
      }
      unlinkSync(files.pid)
    }
  } catch {
    // ignore
  }
  try {
    if (existsSync(files.spec)) unlinkSync(files.spec)
  } catch {
    // ignore
  }
}

/**
 * 启动 watchdog：TUI 被强杀时由它清工作状态 / 停 daemon。
 * TUI 正常退出时插件 cleanup 也会做同样的事，两边都幂等。
 */
export function startWatchdog(
  options: ResolvedOptions,
  runtime: PetRuntime,
  logger: Logger,
): void {
  const files = watchdogFiles(options.home)
  try {
    mkdirSync(petDataDir(options.home), { recursive: true })
    const spec = {
      tuiPid: process.pid,
      daemonPid: runtime.pid,
      port: runtime.port,
      token: runtime.token,
      stopDaemon: !options.keepAlive,
      leaseFile: leaseFile(options.home),
      runtimeFile: runtimeFile(options.home),
      logFile: logFile(options.home),
      pidFile: files.pid,
      startedAt: Date.now(),
    }
    writeFileSync(files.spec, JSON.stringify(spec), { encoding: "utf8", mode: 0o600 })
    const nodeBin = process.env.OC_PET_NODE || "node"
    const child = spawn(nodeBin, [resolveWatchdogEntry(), files.spec], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, DSH_HOME: options.home },
    })
    child.once("error", (error) => logger.warn(`watchdog 启动失败：${String(error)}`))
    child.unref()
    if (child.pid) {
      try {
        writeFileSync(files.pid, String(child.pid), { mode: 0o600 })
      } catch {
        // ignore
      }
      logger.info(`watchdog pid=${child.pid}`)
    }
  } catch (error) {
    logger.warn(`watchdog 启动失败：${String(error)}`)
  }
}
