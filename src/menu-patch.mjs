/**
 * OpenCode 桌面菜单裁剪（运行时补丁，非上游源码改动）。
 *
 * 只删三样 OpenCode 不需要/不适用的桌面菜单项：
 *   - 打开网站 / 打开软件（OpenCode 没有对应的「宿主应用」入口）
 *   - 查看余额（改由插件自己的「更多 → 查看余额」承接）
 *   - 显示位置（OpenCode 只有桌面端，网页/两者/都不 没有意义；/pet 命令负责显隐）
 *
 * 保留：碎碎念 / 对话 / 回到初始位置 / 重载配置 / 动作树。
 *
 * 实现是「对 node_modules 里的 sprite.js 做一次字符串替换」：
 *   - 幂等：有 marker 就跳过；
 *   - 失败明确返回 reason（上游改了这段结构时，契约测试会红，不会静默）。
 */
import { readFileSync, writeFileSync } from "node:fs"

export const MENU_PATCH_MARKER = "oc-pet: menu trimmed for OpenCode"

export function applyMenuPatch(filePath) {
  let source
  try {
    source = readFileSync(filePath, "utf8")
  } catch (error) {
    return { ok: false, applied: false, reason: `read-failed: ${String(error)}` }
  }

  if (source.includes(MENU_PATCH_MARKER)) return { ok: true, applied: false }

  const startMarker = "    const tools = [\n      {\n        label: OPEN_TARGET"
  const start = source.indexOf(startMarker)
  if (start < 0) return { ok: false, applied: false, reason: "tools block not found" }

  const endMarker = "\n    ];"
  const end = source.indexOf(endMarker, start)
  if (end < 0) return { ok: false, applied: false, reason: "tools block end not found" }

  let next =
    source.slice(0, start) +
    "    const tools = [];\n    // " +
    MENU_PATCH_MARKER +
    source.slice(end + endMarker.length)

  const balanceLine = "    tools.push({ label: '查看余额', action: 'show-balance' });\n"
  if (!next.includes(balanceLine)) {
    return { ok: false, applied: false, reason: "show-balance line not found" }
  }
  next = next.replace(balanceLine, "")

  const displayLine = "      S.displayMenuBranch(),\n"
  if (!next.includes(displayLine)) {
    return { ok: false, applied: false, reason: "displayMenuBranch line not found" }
  }
  next = next.replace(displayLine, "")

  try {
    writeFileSync(filePath, next)
  } catch (error) {
    return { ok: false, applied: false, reason: `write-failed: ${String(error)}` }
  }
  return { ok: true, applied: true }
}
