/**
 * OpenCode 桌面菜单裁剪（运行时补丁，非上游源码改动）。
 *
 * 只删两样 OpenCode 不需要/不适用的桌面菜单项：
 *   - 查看余额（改由插件自己的「更多 → 查看余额」承接）
 *   - 显示位置（OpenCode 只有桌面端，网页/两者/都不 没有意义；/pet 命令负责显隐）
 *
 * 保留：打开 AI 设置（standalone 形态下就是 /pet-ai 打开的同一页）、待办事项、
 * 碎碎念 / 对话 / 回到初始位置 / 重载配置 / 动作树。
 *
 * 上游 0.4.x 把右键菜单从 sprite.js 拆到了 sprite/menu.js，且 standalone 的
 * 「打开网站」改成了「打开 AI 设置」。这里同时兼容旧版内联菜单与新版拆分菜单：
 *   - 幂等：有 marker 就跳过；
 *   - 失败明确返回 reason（上游改了这段结构时，契约测试会红，不会静默）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const MENU_PATCH_MARKER = "oc-pet: menu trimmed for OpenCode"

/** 上游菜单文件位置：0.4+ 在 sprite/menu.js，0.3.x 内联在 sprite.js。 */
export function menuFileFor(upstreamRoot) {
  const modern = join(upstreamRoot, "runtime", "electron-helper", "sprite", "menu.js")
  if (existsSync(modern)) return modern
  return join(upstreamRoot, "runtime", "electron-helper", "sprite.js")
}

const SHOW_BALANCE_MODERN = "      { label: '查看余额', action: 'show-balance' },\n"
const SHOW_BALANCE_LEGACY = "    tools.push({ label: '查看余额', action: 'show-balance' });\n"
const DISPLAY_LINE = "      S.displayMenuBranch(),\n"

export function applyMenuPatch(filePath) {
  let source
  try {
    source = readFileSync(filePath, "utf8")
  } catch (error) {
    return { ok: false, applied: false, reason: `read-failed: ${String(error)}` }
  }

  if (source.includes(MENU_PATCH_MARKER)) return { ok: true, applied: false }

  let next = source

  // 0.3.x：工具项直接内联在 sprite.js 的 tools 数组里，首项是「打开网站/打开软件」。
  // 0.4+：菜单已拆到 sprite/menu.js，首项在 standalone 下是「打开 AI 设置」，需要保留。
  const legacyStartMarker = "    const tools = [\n      {\n        label: OPEN_TARGET"
  const legacyStart = next.indexOf(legacyStartMarker)
  if (legacyStart >= 0) {
    const endMarker = "\n    ];"
    const end = next.indexOf(endMarker, legacyStart)
    if (end < 0) return { ok: false, applied: false, reason: "tools block end not found" }
    next =
      next.slice(0, legacyStart) +
      "    const tools = [];\n    // " +
      MENU_PATCH_MARKER +
      next.slice(end + endMarker.length)
  }

  if (next.includes(SHOW_BALANCE_LEGACY)) {
    next = next.replace(SHOW_BALANCE_LEGACY, "")
  } else if (next.includes(SHOW_BALANCE_MODERN)) {
    next = next.replace(SHOW_BALANCE_MODERN, "")
  } else {
    return { ok: false, applied: false, reason: "show-balance entry not found" }
  }

  if (!next.includes(DISPLAY_LINE)) {
    return { ok: false, applied: false, reason: "displayMenuBranch line not found" }
  }
  next = next.replace(DISPLAY_LINE, "")

  // 新版拆分菜单没有旧的 tools 块，marker 挂在文件头的 'use strict' 后面。
  if (!next.includes(MENU_PATCH_MARKER)) {
    const strict = "'use strict';\n"
    if (!next.includes(strict)) return { ok: false, applied: false, reason: "strict mode header not found" }
    next = next.replace(strict, strict + "// " + MENU_PATCH_MARKER + "\n")
  }

  try {
    writeFileSync(filePath, next)
  } catch (error) {
    return { ok: false, applied: false, reason: `write-failed: ${String(error)}` }
  }
  return { ok: true, applied: true }
}
