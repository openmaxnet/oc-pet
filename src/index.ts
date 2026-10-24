/**
 * OpenCode server 插件入口（可选）。
 *
 * 目前只占位：桌宠的启停与事件映射全部在 CLI/TUI 侧（./plugin-tui.ts），
 * 因为只有 CLI 插件能保证「开 TUI 才出现、关最后一个 TUI 才收起」。
 *
 * 后续如果需要余额 / 对话 / 碎碎念，在这里接 ctx.generate.text /
 * ctx.integration.connection.resolve，再通过本机 HTTP 推给同一个 daemon。
 */
export default {
  id: "oc-pet-server",
  setup(): () => void {
    return () => {}
  },
}
