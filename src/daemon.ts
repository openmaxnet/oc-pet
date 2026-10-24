import { createRequire } from "node:module"
import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { leaseFile, lockFile, petDataDir, runtimeFile, sleep, type Logger, type ResolvedOptions } from "./config"

/** standalone 进程写出的能力文件（上游 src/standalone/runtime-state.ts 的契约）。 */
export interface PetRuntime {
  name?: string
  pid: number
  port: number
  token: string
  startedAt?: string
  settingsUrl?: string
  pluginRoot?: string
}

export interface EnsureResult {
  runtime: PetRuntime
  /** 本次是否由我们拉起；false = 复用了已有 daemon。 */
  spawned: boolean
  child?: ChildProcess
}

interface LeaseState {
  sessions: number[]
  spawnedBy?: number
  updatedAt?: string
}

const require = createRequire(import.meta.url)

/** 解析已安装的 dsh-pet 包根（不 import 它的入口，避免 DSH 私有依赖）。 */
export function resolveUpstreamRoot(): string {
  return dirname(require.resolve("dsh-pet/package.json"))
}

export function resolveStandaloneEntry(): string {
  const entry = join(resolveUpstreamRoot(), "lib", "standalone.js")
  if (!existsSync(entry)) throw new Error(`dsh-pet standalone 入口不存在：${entry}`)
  return entry
}

export function readRuntime(home: string): PetRuntime | undefined {
  try {
    const raw = JSON.parse(readFileSync(runtimeFile(home), "utf8")) as Partial<PetRuntime>
    if (typeof raw.pid !== "number" || typeof raw.port !== "number" || typeof raw.token !== "string") return undefined
    return raw as PetRuntime
  } catch {
    return undefined
  }
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "EPERM"
  }
}

export interface HealthResult {
  ok: boolean
  pid?: number
  version?: string
}

export async function health(port: number, timeoutMs = 1500): Promise<HealthResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    if (!response.ok) return { ok: false }
    const body = (await response.json()) as { pid?: number; version?: string }
    return { ok: true, pid: body.pid, version: body.version }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return undefined
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
  renameSync(tmp, file)
}

function pruneLease(lease: LeaseState): LeaseState {
  const sessions = [...new Set(lease.sessions ?? [])].filter((pid) => isPidAlive(pid))
  return { ...lease, sessions }
}

function readLease(home: string): LeaseState {
  const parsed = readJson<LeaseState>(leaseFile(home))
  return pruneLease(parsed && typeof parsed === "object" ? parsed : { sessions: [] })
}

function writeLease(home: string, lease: LeaseState): void {
  writeJsonAtomic(leaseFile(home), { ...lease, sessions: [...new Set(lease.sessions)].filter((pid) => isPidAlive(pid)) })
}

/** 简单的跨进程锁：防止两个 TUI 同时发现「没有 daemon」然后各拉一只。 */
async function withLock<T>(home: string, logger: Logger, fn: () => Promise<T>): Promise<T> {
  const file = lockFile(home)
  mkdirSync(dirname(file), { recursive: true })
  const deadline = Date.now() + 8000
  let fd: number | undefined
  while (Date.now() < deadline) {
    try {
      fd = openSync(file, "wx")
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      break
    } catch {
      // 锁已存在：判断是否 stale（超过 30s 或持有者已死）
      try {
        const holder = readJson<{ pid?: number; at?: number }>(file)
        const stale =
          !holder ||
          typeof holder.pid !== "number" ||
          !isPidAlive(holder.pid) ||
          Date.now() - (holder.at ?? 0) > 30_000
        if (stale) {
          unlinkSync(file)
          continue
        }
      } catch {
        // 读不到也当 stale，下一次循环重试
      }
      await sleep(150)
    }
  }
  if (fd === undefined) {
    logger.warn("daemon 锁等待超时，继续尝试（可能拉起第二个实例）")
    return await fn()
  }
  try {
    return await fn()
  } finally {
    try {
      closeSync(fd)
      unlinkSync(file)
    } catch {
      // ignore
    }
  }
}

async function waitForRuntime(
  home: string,
  child: ChildProcess,
  logger: Logger,
  timeoutMs = 60_000,
  getSpawnError?: () => Error | undefined,
): Promise<PetRuntime> {
  const deadline = Date.now() + timeoutMs
  let lastError = ""
  while (Date.now() < deadline) {
    const spawnError = getSpawnError?.()
    if (spawnError) throw spawnError
    if (child.exitCode !== null) {
      throw new Error(`dsh-pet standalone 提前退出（code=${child.exitCode}）${lastError ? `：${lastError}` : ""}`)
    }
    const runtime = readRuntime(home)
    if (runtime && runtime.pid === child.pid) {
      const h = await health(runtime.port)
      if (h.ok && (!h.pid || h.pid === runtime.pid)) return runtime
    }
    if (runtime && runtime.pid !== child.pid) {
      // 别的进程抢先写了 runtime（通常是另一个 TUI 刚拉起）：直接复用
      const h = await health(runtime.port)
      if (h.ok && isPidAlive(runtime.pid)) {
        logger.info(`复用并发启动的 daemon pid=${runtime.pid} port=${runtime.port}`)
        try {
          child.kill()
        } catch {
          // ignore
        }
        return runtime
      }
    }
    await sleep(200)
  }
  throw new Error(`等待 dsh-pet standalone 就绪超时（${timeoutMs}ms）`)
}

async function spawnDaemon(options: ResolvedOptions, logger: Logger): Promise<EnsureResult> {
  const entry = resolveStandaloneEntry()
  const nodeBin = process.env.OC_PET_NODE || "node"
  const args = [entry]
  if (options.port) args.push("--port", String(options.port))
  logger.info(`启动 dsh-pet standalone：${nodeBin} ${args.join(" ")}（DSH_HOME=${options.home}）`)

  const child = spawn(nodeBin, args, {
    cwd: resolveUpstreamRoot(),
    env: { ...process.env, DSH_HOME: options.home },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: true,
  })
  child.stdout?.on("data", (chunk) => logger.debug(`daemon: ${String(chunk).trimEnd()}`))
  child.stderr?.on("data", (chunk) => logger.debug(`daemon!: ${String(chunk).trimEnd()}`))
  let spawnError: Error | undefined
  child.once("error", (error) => {
    spawnError = error instanceof Error ? error : new Error(String(error))
    logger.error(`daemon spawn 失败：${String(error)}`)
  })

  const runtime = await waitForRuntime(options.home, child, logger, 60_000, () => spawnError)
  child.unref()
  logger.info(`daemon 就绪 pid=${runtime.pid} port=${runtime.port}`)
  return { runtime, spawned: true, child }
}

export async function ensureDaemon(options: ResolvedOptions, logger: Logger): Promise<EnsureResult> {
  return await withLock(options.home, logger, async () => {
    const existing = readRuntime(options.home)
    if (existing && isPidAlive(existing.pid)) {
      const h = await health(existing.port)
      if (h.ok) {
        logger.info(`复用已有 daemon pid=${existing.pid} port=${existing.port}`)
        return { runtime: existing, spawned: false }
      }
      logger.warn(`runtime 文件存在但 /health 不通（pid=${existing.pid} port=${existing.port}）`)
    }

    // 清掉 stale runtime：只在确定进程不在时删，避免误删正在启动的 daemon
    if (existing && !isPidAlive(existing.pid)) {
      try {
        unlinkSync(runtimeFile(options.home))
      } catch {
        // ignore
      }
    }
    return await spawnDaemon(options, logger)
  })
}

export async function stopDaemon(home: string, runtime: PetRuntime, logger: Logger): Promise<void> {
  if (!isPidAlive(runtime.pid)) {
    removeRuntimeIfOwned(home, runtime.pid)
    return
  }
  logger.info(`停止 daemon pid=${runtime.pid}`)
  try {
    await fetch(`http://127.0.0.1:${runtime.port}/shutdown`, {
      method: "POST",
      headers: { "x-dsh-pet-token": runtime.token, connection: "close" },
      signal: AbortSignal.timeout(3000),
    })
  } catch (error) {
    logger.warn(`/shutdown 调用失败：${String(error)}`)
  }
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (!isPidAlive(runtime.pid)) {
      removeRuntimeIfOwned(home, runtime.pid)
      return
    }
    await sleep(200)
  }
  try {
    process.kill(runtime.pid)
    logger.warn(`daemon 未按时退出，已强制结束 pid=${runtime.pid}`)
  } catch (error) {
    logger.warn(`强制结束 daemon 失败：${String(error)}`)
  }
  await sleep(300)
  removeRuntimeIfOwned(home, runtime.pid)
}

/** 只删属于这个 pid 的 runtime 文件，避免误删别的 daemon 刚写的新文件。 */
export function removeRuntimeIfOwned(home: string, pid: number): void {
  const current = readRuntime(home)
  if (!current || current.pid !== pid) return
  try {
    unlinkSync(runtimeFile(home))
  } catch {
    // ignore
  }
}

export function addLease(home: string, spawned: boolean): number {
  const lease = readLease(home)
  if (!lease.sessions.includes(process.pid)) lease.sessions.push(process.pid)
  if (spawned) lease.spawnedBy = process.pid
  writeLease(home, lease)
  return lease.sessions.length
}

/** 移除本进程租约；返回「是否应该停止 daemon」。 */
export function releaseLease(home: string, logger: Logger): boolean {
  const lease = readLease(home)
  lease.sessions = lease.sessions.filter((pid) => pid !== process.pid)
  writeLease(home, lease)
  if (lease.sessions.length > 0) {
    logger.debug(`还有 ${lease.sessions.length} 个 TUI 在使用桌宠，不停止 daemon`)
    return false
  }
  if (lease.spawnedBy === undefined) {
    logger.debug("daemon 不是本适配层拉起的（可能手动启动），不停止")
    return false
  }
  if (lease.spawnedBy === process.pid || !isPidAlive(lease.spawnedBy)) return true
  logger.debug(`daemon 由仍在运行的 pid=${lease.spawnedBy} 拉起，不停止`)
  return false
}

/**
 * 多 TUI 时只让「租约里 PID 最小」的那个执行需要单点的动作
 * （系统通知 / 余额自动刷新 / 第三方菜单轮询 / AI 自动配置）。
 * 主实例退出后，剩余实例在下一拍/下一个事件自动接管。
 */
export function isPrimaryInstance(home: string): boolean {
  const lease = readLease(home)
  const live = lease.sessions.filter((pid) => isPidAlive(pid))
  if (live.length === 0) return true
  return process.pid === Math.min(...live)
}

export function ensureDataDir(home: string): void {
  mkdirSync(petDataDir(home), { recursive: true })
}
