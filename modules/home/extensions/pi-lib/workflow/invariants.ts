import {
  duplicateSwormToolClassifications,
  RAW_FILE_MUTATION_TOOLS,
  SWORM_CONFIG_MUTATION_TOOLS,
  SWORM_MUTATION_TOOLS,
  unclassifiedSwormTools
} from './profiles.ts'
import type { WorkflowId, WorkflowProfile } from './types.ts'

export interface WorkflowProfileInvariantProblem {
  readonly profileId?: WorkflowId
  readonly code: string
  readonly message: string
}

export class WorkflowProfileInvariantError extends Error {
  constructor(readonly problems: readonly WorkflowProfileInvariantProblem[]) {
    super(problems.map((problem) => problem.message).join('\n'))
    this.name = 'WorkflowProfileInvariantError'
  }
}

export function assertWorkflowProfileInvariants(
  profiles: readonly WorkflowProfile[],
  knownToolNames: readonly string[] = []
): void {
  const problems = collectWorkflowProfileInvariantProblems(profiles, knownToolNames)
  if (problems.length > 0) throw new WorkflowProfileInvariantError(problems)
}

export function collectWorkflowProfileInvariantProblems(
  profiles: readonly WorkflowProfile[],
  knownToolNames: readonly string[] = []
): readonly WorkflowProfileInvariantProblem[] {
  const problems: WorkflowProfileInvariantProblem[] = []
  const knownTools = knownToolNames.length > 0 ? new Set(knownToolNames) : undefined

  for (const duplicate of duplicateSwormToolClassifications()) {
    problems.push({
      code: 'sworm-duplicate-classification',
      message: `Sworm tool classified in multiple policy groups: ${duplicate}`
    })
  }

  for (const missing of unclassifiedSwormTools(knownToolNames)) {
    problems.push({
      code: 'sworm-unclassified',
      message: `Sworm tool missing policy classification: ${missing}`
    })
  }

  for (const profile of profiles) {
    const blockedTools = new Set([...profile.toolAccess.blockedTools, ...profile.mutation.blockedTools])
    const needsTools = unique(profile.toolAccess.needsTools)
    const optionalTools = unique(profile.toolAccess.optionalTools)
    const onlyAllowedTools = unique(profile.toolAccess.onlyAllowedTools ?? [])
    const defaultTools = unique(needsTools, optionalTools, onlyAllowedTools)

    for (const toolName of needsTools) {
      if (blockedTools.has(toolName)) {
        problems.push({
          profileId: profile.id,
          code: 'needed-tool-blocked',
          message: `${profile.id} needs blocked tool: ${toolName}`
        })
      }
      if (knownTools && !knownTools.has(toolName)) {
        problems.push({
          profileId: profile.id,
          code: 'needed-tool-missing',
          message: `${profile.id} needs unknown tool: ${toolName}`
        })
      }
    }

    for (const toolName of optionalTools) {
      if (blockedTools.has(toolName)) {
        problems.push({
          profileId: profile.id,
          code: 'optional-tool-blocked',
          message: `${profile.id} marks blocked tool as optional: ${toolName}`
        })
      }
    }

    for (const toolName of onlyAllowedTools) {
      if (blockedTools.has(toolName)) {
        problems.push({
          profileId: profile.id,
          code: 'only-allowed-tool-blocked',
          message: `${profile.id} allows blocked tool in onlyAllowedTools: ${toolName}`
        })
      }
    }

    if (onlyAllowedTools.length > 0) {
      const onlyAllowed = new Set(onlyAllowedTools)
      for (const toolName of needsTools) {
        if (!onlyAllowed.has(toolName)) {
          problems.push({
            profileId: profile.id,
            code: 'needed-tool-not-only-allowed',
            message: `${profile.id} needs ${toolName} but onlyAllowedTools omits it`
          })
        }
      }
    }

    if (profile.phase === 'authoring') {
      if (profile.mutation.fileMutationTools !== 'block') {
        problems.push({
          profileId: profile.id,
          code: 'authoring-file-mutation-allowed',
          message: `${profile.id} is authoring but does not block raw file mutation tools`
        })
      }
      for (const toolName of RAW_FILE_MUTATION_TOOLS) {
        if (!blockedTools.has(toolName)) {
          problems.push({
            profileId: profile.id,
            code: 'authoring-raw-mutator-not-blocked',
            message: `${profile.id} does not block raw file mutator: ${toolName}`
          })
        }
        if (defaultTools.includes(toolName)) {
          problems.push({
            profileId: profile.id,
            code: 'authoring-raw-mutator-default',
            message: `${profile.id} exposes raw file mutator by default: ${toolName}`
          })
        }
      }
    }

    if (profile.id === 'spec-authoring') {
      const gatedSwormTools: ReadonlySet<string> = new Set([...SWORM_MUTATION_TOOLS, ...SWORM_CONFIG_MUTATION_TOOLS])
      for (const toolName of unique(needsTools, optionalTools)) {
        if (!gatedSwormTools.has(toolName)) continue
        problems.push({
          profileId: profile.id,
          code: 'spec-authoring-sworm-mutator-eager',
          message: `${profile.id} exposes Sworm mutator/config tool before the approval gate: ${toolName}`
        })
      }
    }
  }

  return problems
}

function unique(...groups: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(groups.flat())]
}
