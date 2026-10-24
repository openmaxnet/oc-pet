/**
 * OpenCode Zen / Go 本地转接头（回环 HTTP 代理）。
 *
 * 为什么需要：
 *   OpenCode 官方订阅（provider `opencode-go`）的推理接口要求每次请求带
 *   `x-opencode-session`（稳定会话 ID，官方文档「Where can I use it」；
 *   缺失时接口直接 400 `MissingSessionID`）。而 dsh-pet standalone 的 AI 传输层
 *   只发 `authorization` / `content-type` / `accept` 三个头，设置 schema 是 strict 的，
 *   没有自定义头字段 —— 不改上游源码就无法补这个头。
 *
 * 做法（只补头，不改业务）：
 *
 *   dsh-pet standalone ──Bearer <OAuth access>──▶ 127.0.0.1:<随机端口>/v1/chat/completions
 *                                                        │ 补 x-opencode-session + UA
 *                                                        ▼
 *                                         https://opencode.ai/inference/go/openai/v1/...
 *
 * 约束：
 *   - 只监听 127.0.0.1（不对外）；
 *   - 只代理 `/v1/*`，其它路径 404；
 *   - token 每次请求现取（OpenCode 自己刷新 OAuth 后，5s 内同步到 standalone 设置）；
 *   - 会话 ID 稳定持久化（`$DSH_HOME/dsh-pet/zen-session-id`），符合官方「稳定会话 ID」要求；
 *   - 响应按流式转发（SSE 不缓冲）。
 */
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { dirname, join } from "node:path"

import { petDataDir, type Logger } from "./config"

/** 官方文档给的「应用直连 Go」基址（OpenAI 兼容，`/chat/completions` 由此拼接）。 */
const DEFAULT_UPSTREAM = "https://opencode.ai/inference/go/openai/v1"

/** 请求体上限：宠物只发短对话，8 MB 足够，超出直接拒绝（防本机误用）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** 转发超时：standalone 自己 30s 超时更短，这里留余量兜住挂死连接。 */
const UPSTREAM_TIMEOUT_MS = 120_000

/** 客户端标识（官方要求「用自己的 UA，而不是通用 SDK 名」）。 */
const USER_AGENT = "oc-pet/0.1.1 (opencode desktop pet; +https://opencode.ai/docs/go/)"

export interface ZenProxyOptions {
  /** DSH 数据根（会话 ID 落盘用）。 */
  home: string
  logger: Logger
  /** 现取 OAuth access token；拿不到就 503（等 OpenCode 登录/刷新）。 */
  getToken: () => string | undefined
  /** 上游基址，默认官方 Go 推理接口；单测可注入本地假上游。 */
  upstream?: string
}

export interface ZenProxy {
  /** 可以直接写进 standalone AI 设置的 baseUrl（`http://127.0.0.1:<port>/v1`）。 */
  url: string
  port: number
  /** 稳定会话 ID（写进 x-opencode-session）。 */
  sessionID: string
  close(): Promise<void>
}

function sessionIdFile(home: string): string {
  return join(petDataDir(home), "zen-session-id")
}

/** 会话 ID 必须跨重启稳定（影响上游路由与 prompt 缓存），所以落盘复用。 */
function loadSessionId(home: string, logger: Logger): string {
  const file = sessionIdFile(home)
  try {
    if (existsSync(file)) {
      const value = readFileSync(file, "utf8").trim()
      if (value) return value
    }
  } catch {
    // 读失败当没有：下面重新生成
  }
  const value = randomUUID()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, value, { mode: 0o600 })
  } catch (error) {
    logger.warn(`Zen 会话 ID 无法落盘（本次运行用临时值）：${String(error)}`)
  }
  return value
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error("请求体过大")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function sendJson(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify({ error: { type: "oc_pet_zen_proxy", message } }))
}

/**
 * 起一个回环转接头。端口交给系统分配（0），避免和上游 standalone 的 3080 段冲突。
 * 失败时抛错，由调用方降级（直连 baseUrl 会 400，但不会拖垮插件）。
 */
export async function startZenProxy(options: ZenProxyOptions): Promise<ZenProxy> {
  const upstream = (options.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, "")
  const sessionID = loadSessionId(options.home, options.logger)

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = req.url ?? "/"
    if (!path.startsWith("/v1/")) {
      sendJson(res, 404, "只代理 /v1/*")
      return
    }
    const token = options.getToken()
    if (!token) {
      sendJson(res, 503, "没有可用的 OpenCode OAuth 凭证：请先在 OpenCode 里登录官方订阅")
      return
    }

    const method = req.method ?? "GET"
    const hasBody = method !== "GET" && method !== "HEAD"
    let body: Buffer | undefined
    try {
      body = hasBody ? await readBody(req) : undefined
    } catch (error) {
      sendJson(res, 413, error instanceof Error ? error.message : String(error))
      return
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "x-opencode-session": sessionID,
      "user-agent": USER_AGENT,
      accept: typeof req.headers.accept === "string" ? req.headers.accept : "application/json",
    }
    if (body) headers["content-type"] = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/json"

    const target = `${upstream}${path.slice("/v1".length)}`
    let response: Response
    try {
      response = await fetch(target, {
        method,
        headers,
        body: body && body.length > 0 ? body.toString("utf8") : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
    } catch (error) {
      options.logger.warn(`Zen 转接失败：${String(error)}`)
      sendJson(res, 502, `上游不可达：${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const contentType = response.headers.get("content-type")
    res.writeHead(response.status, contentType ? { "content-type": contentType } : {})
    if (!response.body) {
      res.end()
      return
    }
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
    } catch (error) {
      options.logger.warn(`Zen 转接响应中断：${String(error)}`)
    }
    res.end()
  }

  const server = createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      options.logger.warn(`Zen 转接异常：${String(error)}`)
      if (!res.headersSent) sendJson(res, 500, "转接头内部错误")
      else res.end()
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      const address = server.address()
      if (address && typeof address === "object") resolve(address.port)
      else reject(new Error("无法确定转接头端口"))
    })
  })

  options.logger.info(`Zen 转接头就绪：http://127.0.0.1:${port}/v1 → ${upstream}（session=${sessionID.slice(0, 8)}…）`)

  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    sessionID,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}
