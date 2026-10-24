import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import type { PetRuntime } from "./daemon"
import type { WorkStatusReducer } from "./events"
import { createModelSync } from "./model-sync"

interface Posted {
  path: string
  body: Record<string, unknown>
}

test("model sync follows the active session, patches model/key, and survives config changes", async () => {
  let active: { providerID: string; id: string } | undefined = {
    providerID: "cmdc-wen",
    id: "deepseek/deepseek-v4.1-flash",
  }
  let resolveOk = true
  let settings: Record<string, unknown> = { enabled: false, hasKey: false }
  const posted: Posted[] = []
  const logs: string[] = []

  const home = mkdtempSync(join(tmpdir(), "oc-pet-model-sync-"))
  mkdirSync(join(home, "dsh-pet"), { recursive: true })
  writeFileSync(
    join(home, "dsh-pet", "opencode-leases.json"),
    JSON.stringify({ sessions: [process.pid], spawnedBy: process.pid }),
  )

  const reducer = { activeModel: () => active } as unknown as WorkStatusReducer
  const logger = {
    debug: () => {},
    info: (message: string) => logs.push(message),
    warn: (message: string) => logs.push(message),
    error: (message: string) => logs.push(message),
  }
  const root = {
    async getJson<T>(_path: string): Promise<T> {
      return settings as unknown as T
    },
    async postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
      posted.push({ path, body })
      settings = { ...settings, ...body, enabled: true, hasKey: true }
      return settings as unknown as T
    },
  }
  const resolve = (providerID: string, modelID: string) => {
    if (!resolveOk) return undefined
    const baseUrl =
      providerID === "opencode-go" || providerID === "opencode"
        ? "https://opencode.ai/zen/go/v1"
        : "https://api.commandcode.ai/provider/v1"
    return {
      providerID,
      model: modelID,
      baseUrl,
      apiKey: `key-${providerID}`,
      protocol: "openai-compatible" as const,
      oauth: false,
    }
  }

  const sync = createModelSync({
    context: { ui: { model: { current: () => active } } },
    home,
    runtime: {} as PetRuntime,
    root,
    reducer,
    logger,
    resolve,
  })

  try {
    await sync.syncOnce()
    assert.equal(posted.length, 1)
    assert.equal(posted[0].body.model, "deepseek/deepseek-v4.1-flash")
    assert.equal(posted[0].body.enabled, true)
    assert.equal(posted[0].body.automaticWhispers, true)
    assert.equal(posted[0].body.baseUrl, "https://api.commandcode.ai/provider/v1")

    // 同一模型：不重复写
    await sync.syncOnce()
    assert.equal(posted.length, 1)

    // 同 endpoint 换 provider/模型：只 patch model + apiKey，保留 baseUrl/其它设置
    active = { providerID: "cmdc-huan", id: "deepseek/deepseek-v4.1-flash" }
    await sync.syncOnce()
    assert.equal(posted.length, 2)
    assert.equal(posted[1].body.model, "deepseek/deepseek-v4.1-flash")
    assert.equal(posted[1].body.apiKey, "key-cmdc-huan")
    assert.equal(posted[1].body.baseUrl, undefined)

    // 换 endpoint（不同 provider）：整份更新
    active = { providerID: "opencode-go", id: "deepseek-v4.1-flash" }
    await sync.syncOnce()
    assert.equal(posted.length, 3)
    assert.equal(posted[2].body.baseUrl, "https://opencode.ai/zen/go/v1")
    assert.equal(posted[2].body.model, "deepseek-v4.1-flash")

    // 当前模型没有 key / provider 配置：不写、只告警一次
    resolveOk = false
    active = { providerID: "deepseek-official", id: "deepseek-chat" }
    await sync.syncOnce()
    await sync.syncOnce()
    assert.equal(posted.length, 3)
    assert.equal(logs.filter((line) => line.includes("缺少 provider 配置/凭据")).length, 1)
  } finally {
    sync.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
