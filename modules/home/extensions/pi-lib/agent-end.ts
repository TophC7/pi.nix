import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'

// Single shared agent_end listener per ExtensionAPI drains a queue of one-shot
// callbacks. pi.on has no off handle, so per-call listeners would leak.
const pendingAgentEnd = new WeakMap<ExtensionAPI, Array<(ctx: ExtensionContext) => Promise<void> | void>>()
const agentEndRegistered = new WeakSet<ExtensionAPI>()

export async function deferToAgentEnd(
  pi: ExtensionAPI,
  fn: (ctx: ExtensionContext) => Promise<void> | void
): Promise<void> {
  let queue = pendingAgentEnd.get(pi)
  if (!queue) {
    queue = []
    pendingAgentEnd.set(pi, queue)
  }
  queue.push(fn)
  if (agentEndRegistered.has(pi)) return
  agentEndRegistered.add(pi)
  pi.on('agent_end', async (_event, ctx) => {
    const pending = pendingAgentEnd.get(pi)
    if (!pending || pending.length === 0) return
    const drained = pending.splice(0, pending.length)
    for (const cb of drained) {
      await cb(ctx)
    }
  })
}
