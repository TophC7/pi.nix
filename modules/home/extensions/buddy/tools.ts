import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Type } from 'typebox'
import {
  buddyForget,
  buddyHatch,
  buddyMode,
  buddyMute,
  buddyObserve,
  buddyPet,
  buddyReasoningPurge,
  buddyReasoningStatus,
  buddyRemember,
  buddyRespawn,
  buddyShareHeadless,
  buddyStatus,
  buddyUnmute,
  type BuddyActionResult
} from './actions.ts'
import { refreshBuddyStatus } from './events.ts'

function wrap<T>(result: T): T {
  refreshBuddyStatus()
  return result
}

const VoiceMode = Type.Union([Type.Literal('backseat'), Type.Literal('skillcoach'), Type.Literal('both')])
const ForgetScope = Type.Union([Type.Literal('memories'), Type.Literal('progress'), Type.Literal('all')])
const PurgeScope = Type.Union([Type.Literal('session'), Type.Literal('all')])
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
    name: 'buddy_hatch',
    label: 'Buddy Hatch',
    description: 'Hatch a new Buddy companion. Display the returned hatch animation and stat card verbatim.',
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: 'Optional companion name.' })),
      species: Type.Optional(Type.String({ description: 'Optional species name.' })),
      user_id: Type.Optional(Type.String({ description: 'Optional user id for deterministic companion traits.' }))
    }),
    execute: async (_id, params) => toolResult(wrap(buddyHatch(params)))
  })

  pi.registerTool({
    name: 'buddy_status',
    label: 'Buddy Status',
    description: 'Get the current Buddy status card. Does not hatch a companion.',
    parameters: Type.Object({}),
    execute: async () => toolResult(buddyStatus())
  })

  pi.registerTool({
    name: 'buddy_remember',
    label: 'Buddy Remember',
    description: 'Store a memory for the current Buddy companion. Requires an existing hatch.',
    parameters: Type.Object({
      content: Type.String(),
      importance: Type.Optional(Type.Number({ minimum: 1, maximum: 5 }))
    }),
    execute: async (_id, params) => toolResult(buddyRemember(params))
  })

  pi.registerTool({
    name: 'buddy_respawn',
    label: 'Buddy Respawn',
    description: 'Release the current Buddy companion and clear its local data. Does not hatch a replacement.',
    parameters: Type.Object({}),
    execute: async () => toolResult(wrap(buddyRespawn()))
  })

  pi.registerTool({
    name: 'buddy_observe',
    label: 'Buddy Observe',
    description: 'Record a brief observation after work and return Buddy reaction plus XP. In guard mode, include claims/edges when available; never fabricate claims.',
    parameters: Type.Object({
      summary: Type.String({ description: 'Brief summary of what happened.' }),
      mode: Type.Optional(VoiceMode),
      claims: Type.Optional(Type.Array(ReasoningClaim)),
      edges: Type.Optional(Type.Array(ReasoningEdge)),
      cwd: Type.Optional(Type.String({ description: 'Workspace path hint for guard-mode session scoping.' }))
    }),
    execute: async (_id, params) => toolResult(buddyObserve(params))
  })

  pi.registerTool({
    name: 'buddy_pet',
    label: 'Buddy Pet',
    description: 'Pet the current Buddy companion and award a small session XP event.',
    parameters: Type.Object({}),
    execute: async () => toolResult(buddyPet())
  })

  pi.registerTool({
    name: 'buddy_mute',
    label: 'Buddy Mute',
    description: 'Mute the current Buddy companion.',
    parameters: Type.Object({}),
    execute: async () => toolResult(buddyMute())
  })

  pi.registerTool({
    name: 'buddy_unmute',
    label: 'Buddy Unmute',
    description: 'Unmute the current Buddy companion.',
    parameters: Type.Object({}),
    execute: async () => toolResult(buddyUnmute())
  })

  pi.registerTool({
    name: 'buddy_mode',
    label: 'Buddy Mode',
    description: 'View or set Buddy voice mode and guard mode. Guard mode adds reasoning graph observation without auto-hatching.',
    parameters: Type.Object({
      mode: Type.Optional(VoiceMode),
      guard: Type.Optional(Type.Union([Type.Boolean(), Type.String()]))
    }),
    execute: async (_id, params) => toolResult(buddyMode(params))
  })

  pi.registerTool({
    name: 'buddy_forget',
    label: 'Buddy Forget',
    description: 'Forget Buddy memories or reset local progress for the current companion.',
    parameters: Type.Object({
      scope: Type.Optional(ForgetScope)
    }),
    execute: async (_id, params) => toolResult(buddyForget(params))
  })

  pi.registerTool({
    name: 'buddy_reasoning_status',
    label: 'Buddy Reasoning Status',
    description: 'Show guard-mode reasoning status, current session id, claim/edge counts, and finding count.',
    parameters: Type.Object({ cwd: Type.Optional(Type.String()) }),
    execute: async (_id, params) => toolResult(buddyReasoningStatus(params))
  })

  pi.registerTool({
    name: 'buddy_reasoning_purge',
    label: 'Buddy Reasoning Purge',
    description: 'Purge guard-mode reasoning state for current session or all sessions. Does not delete companion memories.',
    parameters: Type.Object({
      scope: Type.Optional(PurgeScope),
      session_id: Type.Optional(Type.String())
    }),
    execute: async (_id, params) => toolResult(buddyReasoningPurge(params))
  })

  pi.registerTool({
    name: 'buddy_share',
    label: 'Buddy Share',
    description: 'Open an interactive terminal-card Buddy share preview for manual screenshots. Requires Pi TUI.',
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      if (hasInteractiveUi(ctx)) {
        const { openBuddySharePreview } = await import('./ui/share-dialog.ts')
        return toolResult(openBuddySharePreview(ctx))
      }
      return toolResult(buddyShareHeadless())
    }
  })
}

function hasInteractiveUi(ctx: unknown): boolean {
  return typeof (ctx as { ui?: { custom?: unknown } } | null)?.ui?.custom === 'function'
}

function toolResult(result: BuddyActionResult) {
  return {
    content: [{ type: 'text' as const, text: result.text }],
    details: result.details,
    isError: result.isError
  }
}

