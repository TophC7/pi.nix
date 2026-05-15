import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Type } from 'typebox'
import { buddyObserve, buddyRemember, type BuddyActionResult } from './actions.ts'

const Basis = Type.Union([
  Type.Literal('research'),
  Type.Literal('empirical'),
  Type.Literal('deduction'),
  Type.Literal('analogy'),
  Type.Literal('definition'),
  Type.Literal('llm_output'),
  Type.Literal('assumption'),
  Type.Literal('vibes')
])
const Speaker = Type.Union([Type.Literal('user'), Type.Literal('assistant')])
const Confidence = Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])
const EdgeType = Type.Union([Type.Literal('supports'), Type.Literal('depends_on'), Type.Literal('contradicts'), Type.Literal('questions')])
const ReasoningClaim = Type.Object({
  external_id: Type.String({ description: 'Stable local id for this observe call, e.g. c1.' }),
  text: Type.String({ description: 'Atomic claim text.' }),
  basis: Basis,
  speaker: Speaker,
  confidence: Confidence
})
const ReasoningEdge = Type.Object({
  from: Type.String({ description: 'External id from this call or prior claim UUID prefix.' }),
  to: Type.String({ description: 'External id from this call or prior claim UUID prefix.' }),
  type: EdgeType
})

export function registerBuddyTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'buddy_remember',
    label: 'Buddy Remember',
    description: 'Store a durable Buddy memory when the user explicitly asks to remember something or states a stable preference worth preserving.',
    parameters: Type.Object({
      content: Type.String({ description: 'Memory content to preserve.' }),
      importance: Type.Optional(Type.Number({ minimum: 1, maximum: 5, description: 'Memory importance from 1 to 5.' }))
    }),
    execute: async (_id, params) => toolResult(buddyRemember(params))
  })

  pi.registerTool({
    name: 'buddy_observe',
    label: 'Buddy Observe',
    description: 'Record a brief observation after meaningful work and return Buddy reaction plus XP. In guard mode, include only directly evidenced claims/edges; never fabricate claims.',
    parameters: Type.Object({
      summary: Type.String({ description: 'Brief summary of what happened.' }),
      claims: Type.Optional(Type.Array(ReasoningClaim)),
      edges: Type.Optional(Type.Array(ReasoningEdge)),
      cwd: Type.Optional(Type.String({ description: 'Workspace path hint for guard-mode session scoping.' }))
    }),
    execute: async (_id, params) => toolResult(buddyObserve(params))
  })
}

function toolResult(result: BuddyActionResult) {
  return {
    content: [{ type: 'text' as const, text: result.text }],
    details: result.details,
    isError: result.isError
  }
}
