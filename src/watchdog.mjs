#!/usr/bin/env node
/**
 * oc-pet watchdog（独立进程，Node 运行）。
 *
 * 目的：TUI 被强杀 / 崩溃时，cleanup 不会执行，宠物会停在最后一个工作状态。
 * 这个进程只做三件事：
 *   1. 每 2s 检查 TUI 进程是否还活着；
 *   2. TUI 没了 → DELETE /work-status（回到 idle）；
 *   3. 如果 daemon 是本 TUI 拉起的、且没有其他 TUI 租约，→ POST /shutdown。
 *
 * 不依赖任何上游内部模块；只读 runtime/lease 文件 + 本地 HTTP。
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"

const specFile = process.argv[2]
if (!specFile || !existsSync(specFile)) process.exit(1)

let spec
try {
  spec = JSON.parse(readFileSync(specFile, "utf8"))
} catch {
  process.exit(1)
}

try {
  unlinkSync(specFile)
} catch {
  // ignore
}

const startedAt = Date.now()
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000
const POLL_MS = 2000

try {
  writeFileSync(spec.pidFile, String(process.pid), { mode: 0o600 })
} catch {
  // ignore
}

function log(message) {
  if (!spec.logFile) return
  try {
    appendFileSync(spec.logFile, `${new Date().toISOString()} [watchdog] ${message}\n`)
  } catch {
    // ignore
  }
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error) && error.code === "EPERM"
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function call(method, path) {
  try {
    const response = await fetch(`http://127.0.0.1:${spec.port}/dsh-pet-7340/${path}`, {
      method,
      headers: { "x-dsh-pet-token": spec.token, connection: "close" },
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}

async function waitExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await sleep(200)
  }
  return !pidAlive(pid)
}

function readLease() {
  try {
    return JSON.parse(readFileSync(spec.leaseFile, "utf8"))
  } catch {
    return undefined
  }
}

function writeLease(lease) {
  try {
    writeFileSync(spec.leaseFile, JSON.stringify(lease, null, 2), { encoding: "utf8", mode: 0o600 })
  } catch {
    // ignore
  }
}

function removePidFile() {
  try {
    unlinkSync(spec.pidFile)
  } catch {
    // ignore
  }
}

async function cleanup() {
  log(`TUI pid=${spec.tuiPid} 已消失，开始收尾`)
  await call("DELETE", "work-status")
  if (spec.stopDaemon) {
    const lease = readLease()
    if (lease && Array.isArray(lease.sessions)) {
      lease.sessions = [...new Set(lease.sessions)].filter((pid) => pid !== spec.tuiPid && pidAlive(pid))
      writeLease(lease)
      // 两个 TUI 同时退出时，先收尾的那个可能还看到对方的 pid。
      // 等一拍再读一次，避免两边都判断「还有别人」而把 daemon 留下。
      await sleep(1200)
      const again = readLease()
      if (again && Array.isArray(again.sessions)) {
        again.sessions = [...new Set(again.sessions)].filter((pid) => pid !== spec.tuiPid && pidAlive(pid))
        writeLease(again)
        lease.sessions = again.sessions
      }
      const spawnedBy = lease.spawnedBy
      const lastOne = lease.sessions.length === 0
      const ownedByThisTui = spawnedBy === spec.tuiPid || !pidAlive(spawnedBy)
      if (lastOne && ownedByThisTui) {
        await call("POST", "shutdown")
        log("已请求 daemon 退出")
        if (!(await waitExit(spec.daemonPid, 4000))) {
          try {
            process.kill(spec.daemonPid)
            log("daemon 未按时退出，已强制结束")
          } catch (error) {
            log(`强制结束 daemon 失败：${String(error)}`)
          }
        }
        // 强制结束后 runtime 文件可能还在：确认 pid 属于自己再删
        try {
          const current = JSON.parse(readFileSync(spec.runtimeFile, "utf8"))
          if (current && current.pid === spec.daemonPid) unlinkSync(spec.runtimeFile)
        } catch {
          // ignore
        }
      } else {
        log(`保留 daemon（sessions=${lease.sessions.length} spawnedBy=${String(spawnedBy)}）`)
      }
    }
  }
  removePidFile()
}

log(`启动：tuiPid=${spec.tuiPid} daemonPid=${spec.daemonPid} stopDaemon=${spec.stopDaemon}`)

while (true) {
  if (Date.now() - startedAt > MAX_LIFETIME_MS) {
    log("超过最大存活时间，退出")
    removePidFile()
    break
  }
  if (!pidAlive(spec.daemonPid)) {
    log("daemon 已不存在，退出")
    removePidFile()
    break
  }
  if (!pidAlive(spec.tuiPid)) {
    await cleanup()
    break
  }
  await sleep(POLL_MS)
}

process.exit(0)
