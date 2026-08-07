import type { AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai'
import * as piAi from '@earendil-works/pi-ai'

const compat = piAi as any

/** Compatibility wrapper for Pi versions before the stream factory was exported. */
export const newAssistantMessageEventStream: () => AssistantMessageEventStream =
  typeof compat.createAssistantMessageEventStream === 'function'
    ? compat.createAssistantMessageEventStream
    : () => new compat.AssistantMessageEventStream()

export function newAssistantMessage(model: Model<any>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  }
}
