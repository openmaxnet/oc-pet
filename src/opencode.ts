import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** OpenCode 的 auth/config 是「上游事实」：这里只读，不改；读不到就明确降级。 */

export interface OpenCodeModel {
  providerID?: string
  id?: string
}

export interface OpenCodeProvider {
  package?: string
  settings?: { baseURL?: string; [key: string]: unknown }
  models?: Record<string, unknown>
  [key: string]: unknown
}

export interface OpenCodeConfig {
  providers?: Record<string, OpenCodeProvider>
  [key: string]: unknown
}

function dataCandidates(): string[] {
  const xdg = process.env.XDG_DATA_HOME
  const list = [
    xdg ? join(xdg, "opencode", "auth.json") : undefined,
    join(homedir(), ".local", "share", "opencode", "auth.json"),
    join(homedir(), "Library", "Application Support", "opencode", "auth.json"),
  ]
  return list.filter((value): value is string => Boolean(value))
}

function configCandidates(): string[] {
  const xdg = process.env.XDG_CONFIG_HOME
  const list = [
    xdg ? join(xdg, "opencode", "opencode.json") : undefined,
    xdg ? join(xdg, "opencode", "opencode.jsonc") : undefined,
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
    join(homedir(), "Library", "Application Support", "opencode", "opencode.json"),
  ]
  return list.filter((value): value is string => Boolean(value))
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

export function openCodeAuthFile(): string | undefined {
  return dataCandidates().find((file) => existsSync(file))
}

export function openCodeConfigFile(): string | undefined {
  return configCandidates().find((file) => existsSync(file))
}

export function readAuth(): Record<string, unknown> {
  const file = openCodeAuthFile()
  if (!file) return {}
  const parsed = readJsonFile(file)
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
}

export function readGlobalConfig(): OpenCodeConfig | undefined {
  const file = openCodeConfigFile()
  if (!file) return undefined
  const parsed = readJsonFile(file)
  return parsed && typeof parsed === "object" ? (parsed as OpenCodeConfig) : undefined
}

function authKeyOf(auth: Record<string, unknown>, providerID: string): string | undefined {
  const candidates = [providerID]
  if (providerID.startsWith("cmdc-") || providerID === "commandcode") candidates.push("commandcode")
  if (providerID.startsWith("opencode")) candidates.push("opencode-go", "opencode")
  if (providerID.startsWith("deepseek")) candidates.push("deepseek", "deepseek-official")
  for (const key of candidates) {
    const value = auth[key]
    if (typeof value === "string" && value) return value
    if (value && typeof value === "object") {
      const secret = (value as { key?: unknown }).key
      if (typeof secret === "string" && secret) return secret
    }
  }
  return undefined
}

export function authKeyFor(providerID: string): string | undefined {
  const exported = authExportCache?.keys.get(providerID)
  if (exported) return exported
  return authKeyOf(readAuth(), providerID)
}

interface AuthExportEntry {
  integrationID?: unknown
  active?: unknown
  value?: { key?: unknown } | unknown
}

let authExportCache: { at: number; keys: Map<string, string> } | undefined

/**
 * OpenCode 的多账号 key 只在 `opencode auth export` 里（auth.json 只有当前活动账号）。
 * 异步刷新 + 30s 缓存：不阻塞 TUI；优先用同名 provider 的 key，避免把 Wen 的 key 用到 Huan 上。
 * 只在 Bun/opencode 运行时执行（Node 单测里 process.execPath 是 node，跳过）。
 */
export async function refreshAuthExport(force = false): Promise<void> {
  const now = Date.now()
  if (!force && authExportCache && now - authExportCache.at < 30_000) return
  const keys = new Map<string, string>(authExportCache?.keys ?? [])
  if (process.versions.bun) {
    try {
      const result = (await execFileAsync(process.execPath, ["auth", "export"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      })) as unknown as { stdout?: string }
      const raw = String(result?.stdout ?? "")
      const start = raw.indexOf("[")
      const end = raw.lastIndexOf("]")
      if (start >= 0 && end > start) {
        const list = JSON.parse(raw.slice(start, end + 1)) as AuthExportEntry[]
        keys.clear()
        for (const item of list) {
          const id = item?.integrationID
          if (typeof id !== "string" || !id) continue
          const value = item.value
          const key =
            value && typeof value === "object" && typeof (value as { key?: unknown }).key === "string"
              ? (value as { key: string }).key
              : undefined
          if (!key) continue
          if (!keys.has(id) || item.active === true) keys.set(id, key)
        }
      }
    } catch {
      // export 不可用：保留旧缓存，回落到 auth.json / env
    }
  }
  authExportCache = { at: now, keys }
}

function envKeyFor(providerID: string): string | undefined {
  if (providerID.startsWith("opencode")) return process.env.OPENCODE_GO_API_KEY ?? process.env.OPENCODE_API_KEY
  if (providerID.startsWith("deepseek")) return process.env.DEEPSEEK_API_KEY
  return undefined
}

/** 从 CLI 插件的 `context.ui.model.current()` 取当前模型；取不到返回 undefined。 */
export function currentModel(context: unknown): OpenCodeModel | undefined {
  try {
    const ui = (context as { ui?: { model?: { current?: () => unknown } } })?.ui
    const model = ui?.model?.current?.()
    if (!model || typeof model !== "object") return undefined
    const m = model as Record<string, unknown>
    const providerID =
      typeof m.providerID === "string" ? m.providerID : typeof m.provider === "string" ? m.provider : undefined
    const id = typeof m.id === "string" ? m.id : typeof m.model === "string" ? m.model : undefined
    if (!providerID && !id) return undefined
    return { providerID, id }
  } catch {
    return undefined
  }
}

export interface ResolvedAiConfig {
  providerID: string
  model: string
  baseUrl: string
  apiKey: string
  protocol: "openai-compatible" | "anthropic"
}

export function resolveAiConfigFor(providerID: string, modelID: string): ResolvedAiConfig | undefined {
  const config = readGlobalConfig()
  const provider = config?.providers?.[providerID]
  const isCommandCode = providerID === "commandcode" || providerID.startsWith("cmdc-")
  const fallback = isCommandCode
    ? "https://api.commandcode.ai/provider/v1"
    : providerID === "opencode-go"
      ? "https://opencode.ai/zen/go/v1"
      : providerID === "opencode"
        ? "https://opencode.ai/zen/v1"
        : providerID.startsWith("deepseek")
          ? "https://api.deepseek.com/v1"
          : ""
  const baseUrl =
    (typeof provider?.settings?.baseURL === "string" && provider.settings.baseURL) || fallback
  const apiKey = authKeyFor(providerID) ?? envKeyFor(providerID)
  if (!baseUrl || !modelID || !apiKey) return undefined
  const protocol =
    typeof provider?.package === "string" && provider.package.includes("anthropic")
      ? "anthropic"
      : "openai-compatible"
  return { providerID, model: modelID, baseUrl, apiKey, protocol }
}

/**
 * 把 OpenCode 的「当前模型 + provider 配置 + auth.json」翻译成 standalone AI 设置。
 * 只用公开的配置文件/凭据文件，不调用 DSH/OpenCode 私有 API。
 */
export function resolveAiConfig(context: unknown): ResolvedAiConfig | undefined {
  const config = readGlobalConfig()
  const providers = config?.providers ?? {}
  const selected = currentModel(context)
  const providerID =
    selected?.providerID ??
    Object.keys(providers).find((id) => providers[id]?.settings?.baseURL) ??
    "cmdc-wen"
  const provider = providers[providerID]
  const model =
    selected?.id ??
    (provider?.models && Object.keys(provider.models)[0]) ??
    "deepseek/deepseek-v4.1-flash"
  return resolveAiConfigFor(providerID, model)
}

/** 余额 / 通知只需要 provider id + 凭证；与 AI 配置同源。 */
export function resolveOpenCodeProvider(context: unknown): { providerID: string; key?: string } {
  const selected = currentModel(context)
  const providerID = selected?.providerID ?? "cmdc-wen"
  return { providerID, key: authKeyFor(providerID) ?? envKeyFor(providerID) }
}
