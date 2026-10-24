#!/usr/bin/env node
/**
 * 上游升级脚本。原则：**不改 node_modules / 不复制上游源码**，只换 npm 版本号。
 *
 *   node scripts/sync-upstream.mjs --check          # 看当前 vs npm latest
 *   node scripts/sync-upstream.mjs --apply 0.3.9    # 装指定版本并跑契约测试
 *   node scripts/sync-upstream.mjs --latest         # 装 npm latest
 *
 * 契约测试不通过 → 自动回滚到升级前版本，并以 1 退出。
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkgFile = join(root, "package.json")
const upstreamFile = join(root, "upstream.json")
const npm = process.platform === "win32" ? "npm.cmd" : "npm"

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

/** Windows 上直接 spawn npm.cmd 会 EINVAL；统一走 ComSpec，且不用 shell:true（避免 DEP0190）。 */
function npmInvocation(args) {
  if (process.platform === "win32") {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `npm ${args.join(" ")}`],
    }
  }
  return { file: npm, args }
}

function run(args, options = {}) {
  const invocation = npmInvocation(args)
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: root,
    stdio: options.quiet ? "pipe" : "inherit",
    encoding: "utf8",
  })
  if (options.quiet) return result
  return result
}

function latestVersion() {
  const result = run(["view", "dsh-pet", "version"], { quiet: true })
  if (result.status !== 0) {
    throw new Error(`npm view 失败：${result.stderr || result.stdout}`)
  }
  const lines = String(result.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\d+\.\d+/.test(line))
  if (!lines.length) throw new Error(`npm view 没返回版本号：${result.stdout}`)
  return lines[lines.length - 1]
}

function installedVersion() {
  return readJson(pkgFile).dependencies?.["dsh-pet"]
}

function verify() {
  const result = spawnSync(process.execPath, [join(root, "scripts", "verify-upstream.mjs")], {
    cwd: root,
    stdio: "inherit",
  })
  return result.status === 0
}

function apply(version) {
  const before = installedVersion()
  console.log(`[sync] dsh-pet: ${before} -> ${version}`)
  const install = run(["install", `dsh-pet@${version}`, "--save-exact", "--no-audit", "--no-fund"])
  if (install.status !== 0) {
    throw new Error(`npm install dsh-pet@${version} 失败`)
  }

  if (!verify()) {
    console.error(`\n[sync] 契约测试失败，回滚到 ${before} ...`)
    run(["install", `dsh-pet@${before}`, "--save-exact", "--no-audit", "--no-fund"])
    console.error("[sync] 已回滚。请先适配 src/events.ts / src/daemon.ts / src/config.ts，再升级。")
    process.exit(1)
  }

  const upstream = existsSync(upstreamFile) ? readJson(upstreamFile) : {}
  upstream.version = version
  upstream.installedAt = new Date().toISOString().slice(0, 10)
  writeFileSync(upstreamFile, JSON.stringify(upstream, null, 2) + "\n")
  console.log(`[sync] 升级完成：dsh-pet@${version}（契约测试通过，upstream.json 已更新）`)
}

function main() {
  const args = process.argv.slice(2)
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log("用法：node scripts/sync-upstream.mjs --check | --apply <version> | --latest")
    return
  }
  if (args.includes("--check")) {
    const current = installedVersion()
    const latest = latestVersion()
    console.log(`当前：${current}`)
    console.log(`最新：${latest}`)
    console.log(current === latest ? "已是最新。" : "可升级；先跑 verify 再 apply。")
    return
  }
  if (args.includes("--latest")) {
    apply(latestVersion())
    return
  }
  const index = args.indexOf("--apply")
  if (index >= 0) {
    const version = args[index + 1]
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
      console.error("--apply 需要一个版本号，例如 0.3.9")
      process.exit(2)
    }
    apply(version)
    return
  }
  console.error("未知参数。用 --check / --apply <version> / --latest")
  process.exit(2)
}

try {
  main()
} catch (error) {
  console.error("[sync] 失败：", error instanceof Error ? error.message : String(error))
  process.exit(1)
}
