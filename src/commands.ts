import type { Logger } from "./config"
import type { PetRuntime } from "./daemon"
import type { PetHttp } from "./work-status"

interface CommandDeps {
  http: PetHttp
  runtime: PetRuntime
  logger: Logger
  sessionCount: () => number
  stop: () => Promise<void>
  balance: () => Promise<{ ok: boolean; text: string; message?: string }>
  whisper: () => Promise<{ ok: boolean; text: string; message?: string }>
  chat: (text: string) => Promise<{ ok: boolean; text: string; message?: string }>
  openAiSettings: () => boolean
}

/** 从 /config 的成品聚合里拍平所有宠物条目（{ main: { pets: [...] }, ... }）。 */
function flattenPets(config: unknown): Array<{ id?: string; display?: string }> {
  if (!config || typeof config !== "object") return []
  const result: Array<{ id?: string; display?: string }> = []
  for (const entry of Object.values(config as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue
    const pets = (entry as { pets?: unknown }).pets
    if (!Array.isArray(pets)) continue
    for (const pet of pets) {
      if (pet && typeof pet === "object") result.push(pet as { id?: string; display?: string })
    }
  }
  return result
}

function visible(display: string | undefined): boolean {
  return display === "desktop" || display === "both"
}

/**
 * 注册 /pet、/pet-status、/pet-stop。
 * 返回 dispose；插件卸载时连同 keymap layer 一起回收。
 */
export function registerPetCommands(context: unknown, deps: CommandDeps): () => void {
  const ctx = context as {
    keymap?: {
      layer?: (factory: () => unknown) => unknown
    }
    ui?: { toast?: { show?: (input: { message: string; variant?: string; title?: string; duration?: number }) => void } }
  }
  const toast = (message: string, variant: "info" | "success" | "error" = "info", duration?: number): void => {
    try {
      ctx.ui?.toast?.show?.({ message, variant, duration })
    } catch {
      // toast 失败不影响命令本身
    }
  }

  const commands = [
    {
      id: "oc-pet.toggle",
      title: "桌宠：显示 / 隐藏",
      group: "桌宠",
      palette: true,
      slash: { name: "pet" },
      run: async (): Promise<void> => {
        try {
          const config = await deps.http.getJson<unknown>("config")
          const pets = flattenPets(config)
          if (pets.length === 0) {
            toast("没有找到桌宠条目，请先检查 dsh-pet 配置", "error")
            return
          }
          const hide = pets.some((pet) => visible(pet.display))
          const display = hide ? "none" : "desktop"
          for (const pet of pets) {
            if (!pet.id) continue
            await deps.http.postJson("pet-display", { id: pet.id, display })
          }
          deps.logger.info(`/pet -> ${display} (${pets.length} 只)`)
          toast(hide ? "桌宠已隐藏" : "桌宠已显示", "success")
        } catch (error) {
          deps.logger.error(`/pet 失败：${String(error)}`)
          toast(`桌宠操作失败：${error instanceof Error ? error.message : String(error)}`, "error")
        }
      },
    },
    {
      id: "oc-pet.status",
      title: "桌宠：状态",
      group: "桌宠",
      palette: true,
      slash: { name: "pet-status" },
      run: async (): Promise<void> => {
        try {
          const state = await deps.http.getJson<{
            sections?: { workStatus?: { data?: { state?: string | null; task?: string | null } } }
          }>("state")
          const work = state.sections?.workStatus?.data
          const phase = work?.state ?? "idle"
          const task = work?.task ? ` · ${work.task}` : ""
          toast(`桌宠 ${phase}${task}｜会话 ${deps.sessionCount()}｜端口 ${deps.runtime.port}`)
        } catch (error) {
          toast(`读取桌宠状态失败：${error instanceof Error ? error.message : String(error)}`, "error")
        }
      },
    },
    {
      id: "oc-pet.stop",
      title: "桌宠：停止",
      group: "桌宠",
      palette: true,
      slash: { name: "pet-stop" },
      run: async (): Promise<void> => {
        try {
          await deps.stop()
          toast("桌宠已停止（重新打开 TUI 可再次启动）", "success")
        } catch (error) {
          toast(`停止桌宠失败：${error instanceof Error ? error.message : String(error)}`, "error")
        }
      },
    },
    {
      id: "oc-pet.balance",
      title: "桌宠：查看余额",
      group: "桌宠",
      palette: true,
      slash: { name: "pet-balance" },
      run: async (): Promise<void> => {
        toast("正在查询余额…")
        const result = await deps.balance()
        if (result.ok) {
          toast(result.text, "success", 6000)
        } else {
          toast(result.message ? `${result.text}\n${result.message}` : result.text || "余额查询失败", "error", 6000)
        }
      },
    },
    {
      id: "oc-pet.whisper",
      title: "桌宠：碎碎念一句",
      group: "桌宠",
      palette: true,
      slash: { name: "pet-whisper" },
      run: async (): Promise<void> => {
        toast("正在生成…")
        const result = await deps.whisper()
        toast(
          result.ok ? result.text : `生成失败：${result.message ?? result.text ?? "unknown"}`,
          result.ok ? "success" : "error",
          6000,
        )
      },
    },
    {
      id: "oc-pet.chat",
      title: "桌宠：对话",
      group: "桌宠",
      palette: true,
      slash: { name: "pet-chat", arguments: true },
      run: async (input?: string): Promise<void> => {
        const text = String(input ?? "").trim()
        if (!text) {
          toast("用法：/pet-chat <想对桌宠说的话>")
          return
        }
        toast("正在回复…")
        const result = await deps.chat(text)
        toast(
          result.ok ? result.text : `回复失败：${result.message ?? result.text ?? "unknown"}`,
          result.ok ? "success" : "error",
          6000,
        )
      },
    },
    {
      id: "oc-pet.ai",
      title: "桌宠：AI 设置（模型/密钥）",
      group: "桌宠",
      palette: true,
      slash: { name: "pet-ai" },
      run: async (): Promise<void> => {
        const opened = deps.openAiSettings()
        toast(opened ? "已在浏览器打开 AI 设置页" : "打开 AI 设置页失败", opened ? "success" : "error")
      },
    },
  ]

  if (typeof ctx.keymap?.layer !== "function") {
    deps.logger.warn("keymap 服务不可用，/pet 等命令未注册")
    return () => {}
  }
  const layer = ctx.keymap.layer(() => ({
    mode: "global",
    commands,
  }))
  deps.logger.info("已注册命令：/pet /pet-status /pet-stop /pet-balance /pet-whisper /pet-chat /pet-ai")
  return () => {
    try {
      if (typeof layer === "function") (layer as () => void)()
      else if (layer && typeof (layer as { dispose?: () => void }).dispose === "function") {
        ;(layer as { dispose: () => void }).dispose()
      }
    } catch {
      // ignore
    }
  }
}
