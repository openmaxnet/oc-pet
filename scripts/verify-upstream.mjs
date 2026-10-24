#!/usr/bin/env node
/**
 * 上游契约测试：验证当前安装的 dsh-pet 仍然满足 oc-pet 依赖的那一小块公开面。
 *
 * 只测「我们实际用到的」：
 *   1. 包内文件：lib/standalone.js、runtime/electron-helper/{main,host-liveness,shared-core}.js、assets/config.jsonc
 *   2. standalone CLI 能起来（--port + 临时 DSH_HOME，display 改为 none，不弹窗）
 *   3. runtime 文件字段：pid / port / token
 *   4. HTTP：/health、/config、/state、/work-status(POST+DELETE)、/pet-display、/shutdown
 *
 * 退出码 0 = 当前版本兼容；1 = 破坏性变更，不要升级。
 */
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { applyMenuPatch, MENU_PATCH_MARKER } from "../src/menu-patch.mjs"

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const upstreamJson = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"))

const pkgPath = require.resolve("dsh-pet/package.json")
const pkgRoot = dirname(pkgPath)
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))

const failures = []
const passes = []
function check(condition, message) {
  if (condition) passes.push(message)
  else failures.push(message)
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
async function fetchJson(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const text = await response.text()
    let body
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    return { status: response.status, ok: response.ok, body }
  } finally {
    clearTimeout(timer)
  }
}

/** 工作状态叶子可能有节流/合帧，轮询到期望值再判定。 */
async function waitWorkState(base, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fetchJson(`${base}/dsh-pet-7340/state`, {}, 2000)
    const data = last.body?.sections?.workStatus?.data
    if (last.ok && predicate(data)) return { ok: true, data }
    await sleep(150)
  }
  return { ok: false, data: last?.body?.sections?.workStatus?.data, raw: last?.body }
}

function tail(text, lines = 20) {
  return String(text).split(/\r?\n/).slice(-lines).join("\n")
}

async function main() {
  // 1) 版本 + 文件面
  check(
    pkg.version === upstreamJson.version,
    `dsh-pet 版本与 upstream.json 一致（${pkg.version}）`,
  )
  for (const rel of upstreamJson.contract.entrypoints) {
    check(existsSync(join(pkgRoot, rel)), `入口文件存在：${rel}`)
  }
  check(
    typeof pkg.engines?.node === "string",
    `package.json 声明 engines.node（${pkg.engines?.node ?? "缺失"}）`,
  )

  // 菜单裁剪补丁：OpenCode 不需要「打开网站 / 显示位置」，余额改走第三方菜单
  const spriteFile = join(pkgRoot, "runtime", "electron-helper", "sprite.js")
  const menuPatch = applyMenuPatch(spriteFile)
  check(menuPatch.ok, `菜单裁剪补丁已应用（${menuPatch.reason ?? (menuPatch.applied ? "applied" : "already")}）`)
  if (menuPatch.ok) {
    const sprite = readFileSync(spriteFile, "utf8")
    check(sprite.includes(MENU_PATCH_MARKER), "sprite.js 含裁剪 marker")
    check(!sprite.includes("tools.push({ label: '查看余额'"), "内置「查看余额」已移除")
    check(!sprite.includes("S.displayMenuBranch(),"), "内置「显示位置」已移除")
    check(!sprite.includes("action: 'open-site'"), "内置「打开网站」已移除")
  }

  // 2) 临时 HOME + display:web：不弹 Electron 窗口，但动作端点（surface=web）可用
  const temp = mkdtempSync(join(tmpdir(), "oc-pet-contract-"))
  const home = join(temp, "home")
  const petDir = join(home, "dsh-pet")
  mkdirSync(petDir, { recursive: true })
  const defaultConfig = readFileSync(join(pkgRoot, "assets", "config.jsonc"), "utf8")
  const noDesktop = defaultConfig.replace(/"display"\s*:\s*"(?:web|desktop|both|none)"/g, '"display": "web"')
  writeFileSync(join(petDir, "main-config.jsonc"), noDesktop)

  const port = 39000 + Math.floor(Math.random() * 2000)
  const entry = join(pkgRoot, "lib", "standalone.js")
  const child = spawn(process.execPath, [entry, "--port", String(port)], {
    cwd: pkgRoot,
    env: { ...process.env, DSH_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk)
    if (stdout.length > 100_000) stdout = stdout.slice(-50_000)
  })
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
    if (stderr.length > 100_000) stderr = stderr.slice(-50_000)
  })

  const runtimeFile = join(petDir, "standalone-runtime.json")
  let runtime
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break
    if (existsSync(runtimeFile)) {
      try {
        const parsed = JSON.parse(readFileSync(runtimeFile, "utf8"))
        if (parsed?.pid === child.pid && typeof parsed.port === "number" && typeof parsed.token === "string") {
          runtime = parsed
          break
        }
      } catch {
        // 还没写完
      }
    }
    await sleep(200)
  }

  if (!runtime) {
    failures.push("standalone 未在 30s 内写出可用的 runtime 文件")
    console.error("[verify] stdout:\n" + tail(stdout))
    console.error("[verify] stderr:\n" + tail(stderr))
  } else {
    passes.push(`runtime 文件字段完整（pid=${runtime.pid} port=${runtime.port}）`)
    const base = `http://127.0.0.1:${runtime.port}`
    const headers = { "x-dsh-pet-token": runtime.token }

    const health = await fetchJson(`${base}/health`)
    check(health.ok && health.body?.pid === runtime.pid, "GET /health 返回当前 pid")

    const config = await fetchJson(`${base}/dsh-pet-7340/config`)
    const pets = config.body?.main?.pets
    check(config.ok && Array.isArray(pets) && pets.some((pet) => pet.id === "main"), "GET /config 含 main 宠物")

    const state = await fetchJson(`${base}/dsh-pet-7340/state`)
    check(state.ok && state.body?.sections && typeof state.body.sections === "object", "GET /state 结构正常")

    const setWork = await fetchJson(`${base}/dsh-pet-7340/work-status`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ state: "thinking", task: "contract test" }),
    })
    check(setWork.ok, "POST /work-status 成功")

    const afterSet = await waitWorkState(base, (data) => data?.state === "thinking")
    check(afterSet.ok, `POST /work-status 后 /state 反映 thinking（实际 ${JSON.stringify(afterSet.data)}）`)

    const clearWork = await fetchJson(`${base}/dsh-pet-7340/work-status`, { method: "DELETE", headers }, 4000)
    check(
      clearWork.status === 204 || clearWork.ok,
      `DELETE /work-status 成功（status=${clearWork.status}）`,
    )

    const afterClear = await waitWorkState(base, (data) => data === null || data?.state === null)
    check(afterClear.ok, `DELETE 后 /state 回到 idle（实际 ${JSON.stringify(afterClear.data)}）`)

    // 余额 / 第三方菜单 / 碎碎念对话共用到的动作端点（surface=web，避免弹窗）
    const animName =
      config.body?.main?.animations?.idle?.[0] ?? config.body?.main?.animations?.events?.balance?.[0]
    const lock = await fetchJson(`${base}/dsh-pet-7340/lock?pet=main&surface=web`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ttl: 5000 }),
    })
    const lockId = lock.body?.lockId
    check(lock.ok && lock.body?.ok === true && typeof lockId === "string", "POST /lock 成功")

    if (lockId && animName) {
      const anim = await fetchJson(
        `${base}/dsh-pet-7340/anim?pet=main&surface=web&lock=${encodeURIComponent(lockId)}`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ name: animName }),
        },
      )
      check(anim.ok && anim.body?.ok === true, `POST /anim 成功（${animName}）`)
    }

    if (lockId) {
      const broadcast = await fetchJson(
        `${base}/dsh-pet-7340/broadcast?pet=main&surface=web&lock=${encodeURIComponent(lockId)}`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ text: "contract broadcast", anim: false, duration: 1000 }),
        },
      )
      check(broadcast.ok && broadcast.body?.ok === true, "POST /broadcast 成功")

      const sayState = await fetchJson(`${base}/dsh-pet-7340/state`)
      check(
        sayState.body?.pets?.main?.say?.data?.text === "contract broadcast",
        "broadcast 写入 pets.main.say",
      )

      const release = await fetchJson(`${base}/dsh-pet-7340/lock/release?pet=main`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ lockId }),
      })
      check(release.ok && release.body?.ok === true, "POST /lock/release 成功")
    }

    const menuReg = await fetchJson(`${base}/dsh-pet-7340/menu/item`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ owner: "oc-pet-contract", labels: ["查看余额"] }),
    })
    check(menuReg.ok && menuReg.body?.ok === true, "POST /menu/item 成功")

    const menuState = await fetchJson(`${base}/dsh-pet-7340/state`)
    check(
      menuState.body?.sections?.menu?.data?.items?.some((item) => item.owner === "oc-pet-contract"),
      "menu 快照含注册项",
    )

    const menuEvents = await fetchJson(`${base}/dsh-pet-7340/menu/events?owner=oc-pet-contract&wait=0`)
    check(menuEvents.ok && menuEvents.body?.ok === true, "GET /menu/events 成功")

    const menuDel = await fetchJson(`${base}/dsh-pet-7340/menu/item?owner=oc-pet-contract`, {
      method: "DELETE",
      headers,
    })
    check(menuDel.ok && menuDel.body?.ok === true, "DELETE /menu/item 成功")

    const aiSettings = await fetchJson(`${base}/standalone-ai/settings`, { headers })
    check(
      aiSettings.ok && typeof aiSettings.body?.enabled === "boolean",
      "GET /standalone-ai/settings 成功",
    )

    const display = await fetchJson(`${base}/dsh-pet-7340/pet-display`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ id: "main", display: "none" }),
    })
    check(display.ok, "POST /pet-display 成功")

    const shutdown = await fetchJson(`${base}/shutdown`, { method: "POST", headers }, 4000)
    check(shutdown.ok, "POST /shutdown 成功")
  }

  // 3) 收尾：先等优雅退出，超时再杀
  const stopDeadline = Date.now() + 10_000
  while (Date.now() < stopDeadline && child.exitCode === null) await sleep(200)
  if (child.exitCode === null) {
    child.kill()
    await sleep(500)
  }
  try {
    rmSync(temp, { recursive: true, force: true })
  } catch {
    // ignore
  }

  console.log("\n[verify] 通过：")
  for (const pass of passes) console.log(`  ✓ ${pass}`)
  if (failures.length) {
    console.log("\n[verify] 失败：")
    for (const failure of failures) console.log(`  ✗ ${failure}`)
    console.error("\n[verify] 上游契约不兼容，不要升级。")
    process.exit(1)
  }
  console.log(`\n[verify] PASS dsh-pet@${pkg.version}`)
}

main().catch((error) => {
  console.error("[verify] 未捕获异常：", error)
  process.exit(1)
})
