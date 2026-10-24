#!/usr/bin/env node
/**
 * 把 oc-pet 装进 OpenCode 全局 cli.json（CLI-only 插件，连远程 server 也生效）。
 *
 *   node scripts/install-global.mjs          # 安装/更新
 *   node scripts/install-global.mjs --remove # 卸载
 *
 * 只动 plugins 数组里属于本项目的条目；其他插件原样保留。
 * 写入前会在同目录留一份 cli.json.bak-<timestamp>。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = resolve(root).replace(/\\/g, "/")
const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const cliDir = join(configHome, "opencode")
const cliFile = join(cliDir, "cli.json")
const remove = process.argv.includes("--remove")

mkdirSync(cliDir, { recursive: true })

let config = { $schema: "https://opencode.ai/v2/cli.json", plugins: [] }
if (existsSync(cliFile)) {
  try {
    config = JSON.parse(readFileSync(cliFile, "utf8"))
  } catch (error) {
    console.error(`[install] 读取 ${cliFile} 失败：${String(error)}`)
    process.exit(1)
  }
}

function isOcPet(entry) {
  if (typeof entry === "string") {
    const normalized = entry.replace(/\\/g, "/")
    return normalized === target || normalized === `${target}/local-plugin` || normalized === "oc-pet"
  }
  if (entry && typeof entry === "object" && typeof entry.package === "string") {
    return entry.package === "oc-pet" || entry.package === target
  }
  return false
}

const before = Array.isArray(config.plugins) ? config.plugins : []
const kept = before.filter((entry) => !isOcPet(entry))
if (!remove) kept.unshift(target)
config.plugins = kept

const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const backup = `${cliFile}.bak-${stamp}`
if (existsSync(cliFile)) copyFileSync(cliFile, backup)
writeFileSync(cliFile, JSON.stringify(config, null, 2) + "\n")

console.log(`[install] 配置：${cliFile}`)
if (existsSync(cliFile)) console.log(`[install] 备份：${backup}`)
console.log(`[install] plugins:`)
for (const entry of config.plugins) {
  console.log(`  - ${typeof entry === "string" ? entry : entry?.package ?? JSON.stringify(entry)}`)
}
if (remove) console.log("[install] 已移除 oc-pet。")
else console.log(`[install] 已加入：${target}`)
console.log("[install] 运行中的 TUI 通常会自动热加载；若没有，重启 TUI 即可。")
