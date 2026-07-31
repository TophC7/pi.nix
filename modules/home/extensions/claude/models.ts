// Canonical selection and display order for the model picker.

export const MODEL_IDS_IN_ORDER = ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const

type ClaudeModelId = (typeof MODEL_IDS_IN_ORDER)[number]

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// keep MODEL_IDS_IN_ORDER ordering, and expose Claude CLI's xhigh/max effort
// levels even when upstream model metadata has not opted into them yet.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
  return MODEL_IDS_IN_ORDER.map((id) => piAiModels.find((m) => m.id === id))
    .filter((m) => m != null)
    .map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
      id,
      name,
      reasoning,
      input,
      contextWindow,
      maxTokens,
      thinkingLevelMap: {
        ...thinkingLevelMap,
        xhigh: 'xhigh',
        max: 'max'
      },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }))
}

export type ClaudeCodeRuntimeModel = {
  cliModelId: string
  contextWindow: number
}

const TWO_HUNDRED_K_CONTEXT = 200_000
const ONE_M_CONTEXT = 1_000_000

export function resolveClaudeCodeRuntimeModel(modelId: string): ClaudeCodeRuntimeModel {
  if (!isClaudeModelId(modelId)) throw new Error(`Unsupported Claude model: ${modelId}`)

  switch (modelId) {
    case 'claude-fable-5':
    case 'claude-opus-5':
    case 'claude-sonnet-5':
      return { cliModelId: `${modelId}[1m]`, contextWindow: ONE_M_CONTEXT }
    case 'claude-haiku-4-5':
      return {
        cliModelId: 'claude-haiku-4-5',
        contextWindow: TWO_HUNDRED_K_CONTEXT
      }
  }
  return assertNever(modelId)
}

function isClaudeModelId(modelId: string): modelId is ClaudeModelId {
  return MODEL_IDS_IN_ORDER.some((supported) => supported === modelId)
}

function assertNever(modelId: never): never {
  throw new Error(`Unsupported Claude model: ${modelId}`)
}

export function claudeCodeModelId(model: { id: string }): string {
  return resolveClaudeCodeRuntimeModel(model.id).cliModelId
}

// Keep Pi's advertised context window aligned with the Claude CLI model suffix
// so status and auto-compaction thresholds remain accurate.
export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(
  models: T[]
): T[] {
  return models.map((model) => {
    const { contextWindow } = resolveClaudeCodeRuntimeModel(model.id)
    const name = contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(model.name) ? `${model.name} 1M` : model.name
    return contextWindow === model.contextWindow && name === model.name ? model : { ...model, contextWindow, name }
  })
}
