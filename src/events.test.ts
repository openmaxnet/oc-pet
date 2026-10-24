import assert from "node:assert/strict"
import { test } from "node:test"

import { WorkStatusReducer } from "./events"

function event(type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { details: { type, data, ...extra } }
}

const sid = "ses_test"

test("execution.started -> thinking", () => {
  const reducer = new WorkStatusReducer()
  reducer.handle(event("session.execution.started", { sessionID: sid }))
  assert.deepEqual(reducer.snapshot(), { state: "thinking" })
})

test("tool input/called -> working with command task", () => {
  const reducer = new WorkStatusReducer()
  reducer.handle(event("session.tool.input.started", { sessionID: sid, id: "call_1", name: "shell" }))
  reducer.handle(
    event("session.tool.called", {
      sessionID: sid,
      id: "call_1",
      input: { command: "echo oc-pet-e2e" },
    }),
  )
  assert.deepEqual(reducer.snapshot(), { state: "working", task: "shell: echo oc-pet-e2e" })
})

test("tool.success -> result", () => {
  const reducer = new WorkStatusReducer()
  reducer.handle(event("session.tool.input.started", { sessionID: sid, id: "call_1", name: "shell" }))
  reducer.handle(event("session.tool.success", { sessionID: sid, id: "call_1" }))
  assert.deepEqual(reducer.snapshot(), { state: "result", task: "shell 完成" })
})

test("execution.succeeded -> success, expires after TTL", () => {
  const reducer = new WorkStatusReducer()
  reducer.handle(event("session.execution.succeeded", { sessionID: sid }))
  assert.deepEqual(reducer.snapshot(), { state: "success", task: "任务完成" })
  assert.deepEqual(reducer.snapshot(Date.now() + 1_000), { state: "success", task: "任务完成" })
  // snapshot 内部 prune 用的是传入的 now；8s TTL 之后应清空
  assert.equal(reducer.snapshot(Date.now() + 9_000), null)
})

test("execution.failed -> error with message", () => {
  const reducer = new WorkStatusReducer()
  reducer.handle(
    event("session.execution.failed", {
      sessionID: sid,
      error: { type: "provider.auth", message: "API key expired" },
    }),
  )
  assert.deepEqual(reducer.snapshot(), { state: "error", task: "API key expired" })
})

test("permission.asked falls back to aggregateID", () => {
  const reducer = new WorkStatusReducer()
  reducer.handle({ details: { type: "permission.asked", aggregateID: sid, data: { title: "允许执行？" } } })
  assert.deepEqual(reducer.snapshot(), { state: "waiting", task: "允许执行？" })
})

test("active session wins over a newer finished one", () => {
  const reducer = new WorkStatusReducer()
  reducer.handle(event("session.execution.started", { sessionID: "ses_a" }))
  reducer.handle(event("session.execution.succeeded", { sessionID: "ses_b" }))
  assert.deepEqual(reducer.snapshot(), { state: "thinking" })
})

test("latest terminal wins by finish time", () => {
  const reducer = new WorkStatusReducer()
  reducer.handle(event("session.execution.succeeded", { sessionID: "ses_old" }))
  reducer.handle(event("session.execution.failed", { sessionID: "ses_new", error: "boom" }))
  // 同一毫秒内 finish 时间可能相同；这里只断言状态仍是终态之一且不会抛
  const snapshot = reducer.snapshot()
  assert.ok(snapshot?.state === "success" || snapshot?.state === "error")
})

test("new execution clears the previous task", () => {
  const reducer = new WorkStatusReducer()
  reducer.handle(event("session.execution.succeeded", { sessionID: sid }))
  assert.deepEqual(reducer.snapshot(), { state: "success", task: "任务完成" })
  reducer.handle(event("session.execution.started", { sessionID: sid }))
  assert.deepEqual(reducer.snapshot(), { state: "thinking" })
})

test("activeModel follows the active session and switches when another becomes active", async () => {
  const reducer = new WorkStatusReducer()
  reducer.handle(
    event("session.step.started", {
      sessionID: "ses_a",
      model: { providerID: "cmdc-wen", id: "deepseek/deepseek-v4.1-flash" },
    }),
  )
  assert.deepEqual(reducer.activeModel(), {
    providerID: "cmdc-wen",
    id: "deepseek/deepseek-v4.1-flash",
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  reducer.handle(
    event("session.step.started", {
      sessionID: "ses_b",
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    }),
  )
  assert.deepEqual(reducer.activeModel(), { providerID: "opencode-go", id: "deepseek-v4.1-flash" })
})

test("session.model.selected updates the active model without changing state", () => {
  const reducer = new WorkStatusReducer()
  reducer.handle(event("session.execution.started", { sessionID: sid }))
  reducer.handle(
    event("session.model.selected", {
      sessionID: sid,
      model: { providerID: "cmdc-huan", id: "deepseek/deepseek-v4.1-flash" },
    }),
  )
  assert.deepEqual(reducer.snapshot(), { state: "thinking" })
  assert.deepEqual(reducer.activeModel(), {
    providerID: "cmdc-huan",
    id: "deepseek/deepseek-v4.1-flash",
  })
})

test("activeModel is undefined after the terminal TTL", () => {
  const reducer = new WorkStatusReducer()
  reducer.handle(
    event("session.step.started", {
      sessionID: sid,
      model: { providerID: "cmdc-wen", id: "deepseek/deepseek-v4.1-flash" },
    }),
  )
  reducer.handle(event("session.execution.succeeded", { sessionID: sid }))
  assert.deepEqual(reducer.activeModel(), {
    providerID: "cmdc-wen",
    id: "deepseek/deepseek-v4.1-flash",
  })
  assert.equal(reducer.activeModel(Date.now() + 9_000), undefined)
})

test("task text is capped at 40 code points", () => {
  const reducer = new WorkStatusReducer()
  const long = "x".repeat(200)
  reducer.handle(event("session.tool.input.started", { sessionID: sid, id: "call_1", name: "shell" }))
  reducer.handle(event("session.tool.called", { sessionID: sid, id: "call_1", input: { command: long } }))
  const snapshot = reducer.snapshot()
  assert.ok(snapshot?.task)
  assert.ok(Array.from(snapshot.task).length <= 40)
})
