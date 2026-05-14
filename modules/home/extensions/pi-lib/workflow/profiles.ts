import type {
  WorkflowBashRule,
  WorkflowId,
  WorkflowLeasePolicy,
  WorkflowMutationPolicy,
  WorkflowProfile,
  WorkflowRecoveryPolicy,
  WorkflowToolAccessPolicy
} from './types.ts'

export const INSPECTION_TOOLS = [
  'read',
  'grep',
  'find',
  'ls',
  'bash',
  'ask_user',
  'AskClaude',
  'subagent',
  'web_search',
  'code_search',
  'fetch_content',
  'get_search_content'
] as const

export const RAW_FILE_MUTATION_TOOLS = ['edit', 'write'] as const

export const IMPLEMENTATION_CORE_TOOLS = ['read', 'grep', 'find', 'ls', 'bash'] as const

export const IMPLEMENTATION_MUTATION_TOOLS = ['bash', ...RAW_FILE_MUTATION_TOOLS] as const

export const SANCTIONED_AUTHORING_WRITE_TOOLS = ['save_plan_draft', 'save_spec'] as const

export const SPEC_FINALIZATION_CONTROL_TOOLS = ['approve_spec_finalization'] as const

export const PLAN_PROMOTION_TOOLS = ['promote_plan'] as const

export const PLAN_WORKFLOW_TOOLS = ['save_plan_draft', ...PLAN_PROMOTION_TOOLS] as const

export const SPEC_WORKFLOW_TOOLS = SANCTIONED_AUTHORING_WRITE_TOOLS

export const SWORM_READ_STATUS_TOOLS = [
  'sworm_bridge_info',
  'sworm_epic_list',
  'sworm_epic_show',
  'sworm_issue_list',
  'sworm_issue_ready',
  'sworm_issue_search',
  'sworm_issue_show',
  'sworm_comment_list',
  'sworm_dependency_list',
  'sworm_config_list',
  'sworm_config_get'
] as const

export const SWORM_MUTATION_TOOLS = [
  'sworm_epic_create',
  'sworm_epic_update',
  'sworm_epic_delete',
  'sworm_issue_create',
  'sworm_issue_update',
  'sworm_issue_delete',
  'sworm_issue_claim',
  'sworm_comment_add',
  'sworm_comment_update',
  'sworm_comment_delete',
  'sworm_dependency_add',
  'sworm_dependency_remove'
] as const

export const SWORM_CONFIG_MUTATION_TOOLS = ['sworm_config_set'] as const

export const SWORM_POLICY_GROUPS = {
  readStatus: SWORM_READ_STATUS_TOOLS,
  mutators: SWORM_MUTATION_TOOLS,
  configMutators: SWORM_CONFIG_MUTATION_TOOLS
} as const

export const SWORM_TOOLS = uniqueTools(SWORM_READ_STATUS_TOOLS, SWORM_MUTATION_TOOLS, SWORM_CONFIG_MUTATION_TOOLS)

export const WORKFLOW_POLICY_TOOL_NAMES = uniqueTools(
  INSPECTION_TOOLS,
  RAW_FILE_MUTATION_TOOLS,
  IMPLEMENTATION_MUTATION_TOOLS,
  SANCTIONED_AUTHORING_WRITE_TOOLS,
  PLAN_PROMOTION_TOOLS,
  SPEC_FINALIZATION_CONTROL_TOOLS,
  SWORM_TOOLS
)

export const SAFE_DEFAULT_TOOLS = ['read', 'grep', 'find', 'ls', 'ask_user'] as const

export const AUTHORING_BASH_RULES: readonly WorkflowBashRule[] = [
  { id: 'rm', pattern: /\brm\b/, reason: 'removes files' },
  { id: 'mv', pattern: /\bmv\b/, reason: 'moves or renames files' },
  { id: 'cp', pattern: /\bcp\b/, reason: 'writes files' },
  { id: 'mkdir', pattern: /\bmkdir\b/, reason: 'creates directories' },
  { id: 'touch', pattern: /\btouch\b/, reason: 'creates or mutates files' },
  {
    id: 'git-mutator',
    pattern: /\bgit\s+(add|commit|push|reset|checkout|switch|merge|rebase|clean|stash|restore|apply|am|pull)\b/,
    reason: 'mutates git state or working tree'
  },
  {
    id: 'redirect',
    pattern: />|>>|\d>/,
    reason: 'writes command output to files'
  },
  {
    id: 'xargs',
    pattern: /\|\s*xargs\b/,
    reason: 'can fan out mutation commands'
  },
  {
    id: 'package-mutator',
    pattern: /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update)\b/,
    reason: 'mutates dependencies'
  }
] as const

export const REVIEW_BASH_RULES: readonly WorkflowBashRule[] = [
  ...AUTHORING_BASH_RULES,
  {
    id: 'sed-in-place',
    pattern: /\bsed\b[^\n]*(?:\s--in-place(?:[=\s]|$)|\s-i(?:\S*|\s|$))/,
    reason: 'edits files in place'
  },
  { id: 'tee', pattern: /\btee\b/, reason: 'writes stdin to files' },
  {
    id: 'chmod-chown',
    pattern: /\b(chmod|chown|truncate)\b/,
    reason: 'mutates file metadata or contents'
  },
  {
    id: 'path-mutator',
    pattern: /\b(dd\b[^\n]*\bof=|install\b|ln\b|rsync\b|patch\b)/,
    reason: 'mutates paths or applies patches'
  },
  {
    id: 'git-ref-mutator',
    pattern:
      /\bgit\s+(?:branch\b[^\n]*(?:\s-d\b|\s-D\b|--delete|\s-m\b|--move)|tag\b[^\n]*(?:\s-d\b|--delete)|worktree\s+(?:add|remove|move|repair)|submodule\s+update)\b/,
    reason: 'mutates git refs, worktrees, or submodules'
  },
  {
    id: 'python-writes',
    pattern: /\bpython[\d.]*\s+-c\b[^\n]*(write|open\([^)]*,\s*["']w|Path\([^)]*\)\.write_)/,
    reason: 'inline Python can write files'
  },
  {
    id: 'inline-script-writes',
    pattern:
      /\b(node|deno|bun|perl|ruby|php)\s+(?:-e|-p|--eval)\b[^\n]*(writeFile|appendFile|createWriteStream|openSync|File\.(?:write|open)|IO\.write|\.write\()/,
    reason: 'inline script can write files'
  }
] as const

const AUTHORING_MUTATION: WorkflowMutationPolicy = {
  fileMutationTools: 'block',
  implementationWrites: 'block',
  mutatingShell: 'block',
  blockedTools: RAW_FILE_MUTATION_TOOLS,
  blockedBash: AUTHORING_BASH_RULES
}

const REVIEW_AUTHORING_MUTATION: WorkflowMutationPolicy = {
  ...AUTHORING_MUTATION,
  blockedBash: REVIEW_BASH_RULES
}

const SPEC_AUTHORING_ALL_TOOLS = uniqueTools(
  INSPECTION_TOOLS,
  SPEC_WORKFLOW_TOOLS,
  SPEC_FINALIZATION_CONTROL_TOOLS,
  SWORM_READ_STATUS_TOOLS,
  SWORM_MUTATION_TOOLS,
  SWORM_CONFIG_MUTATION_TOOLS
)

const IMPLEMENTATION_MUTATION: WorkflowMutationPolicy = {
  fileMutationTools: 'allow',
  implementationWrites: 'allow',
  mutatingShell: 'allow',
  blockedTools: [],
  blockedBash: []
}

const HANDOFF_MUTATION: WorkflowMutationPolicy = {
  fileMutationTools: 'block',
  implementationWrites: 'block',
  mutatingShell: 'block',
  blockedTools: RAW_FILE_MUTATION_TOOLS,
  blockedBash: AUTHORING_BASH_RULES
}

const WORKFLOW_RUN_LEASE: WorkflowLeasePolicy = {
  lifetime: 'workflow-run',
  normalExit: 'previous-active-tools',
  failure: 'restore-previous-or-safe-default',
  cancellation: 'restore-previous-or-safe-default',
  safeDefaultTools: SAFE_DEFAULT_TOOLS
}

const STANDARD_RECOVERY: WorkflowRecoveryPolicy = {
  markerType: 'pi-workflow-state',
  persistMarker: true,
  persistToolSnapshot: true,
  recoverOnSessionStart: true,
  staleAction: 'restore-previous-if-valid',
  safeDefaultTools: SAFE_DEFAULT_TOOLS
}

function uniqueTools(...groups: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(groups.flat())]
}

export function unclassifiedSwormTools(toolNames: readonly string[]): readonly string[] {
  const classified = new Set(SWORM_TOOLS)
  return uniqueTools(toolNames).filter((name) => name.startsWith('sworm_') && !classified.has(name))
}

export function duplicateSwormToolClassifications(): readonly string[] {
  const counts = new Map<string, number>()
  for (const group of Object.values(SWORM_POLICY_GROUPS)) {
    for (const toolName of group) counts.set(toolName, (counts.get(toolName) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([toolName]) => toolName)
}

function additiveToolAccess(
  needsTools: readonly string[],
  optionalTools: readonly string[] = [],
  blockedTools: readonly string[] = []
): WorkflowToolAccessPolicy {
  return {
    needsTools: uniqueTools(needsTools),
    optionalTools: uniqueTools(optionalTools),
    blockedTools: uniqueTools(blockedTools)
  }
}

function exclusiveToolAccess(
  needsTools: readonly string[],
  optionalTools: readonly string[] = [],
  blockedTools: readonly string[] = []
): WorkflowToolAccessPolicy {
  const access = additiveToolAccess(needsTools, optionalTools, blockedTools)
  return {
    ...access,
    onlyAllowedTools: uniqueTools(access.needsTools, access.optionalTools).filter(
      (name) => !access.blockedTools.includes(name)
    )
  }
}

function profile(input: WorkflowProfile): WorkflowProfile {
  return input
}

export const WORKFLOW_PROFILES = [
  profile({
    id: 'plan-authoring',
    owner: 'spec',
    phase: 'authoring',
    label: 'Plan authoring',
    statusKey: 'spec-workflow',
    toolAccess: exclusiveToolAccess(uniqueTools(INSPECTION_TOOLS, PLAN_WORKFLOW_TOOLS), [], RAW_FILE_MUTATION_TOOLS),
    mutation: AUTHORING_MUTATION,
    lease: WORKFLOW_RUN_LEASE,
    recovery: STANDARD_RECOVERY
  }),
  profile({
    id: 'spec-authoring',
    owner: 'spec',
    phase: 'authoring',
    label: 'Spec authoring',
    statusKey: 'spec-workflow',
    toolAccess: {
      needsTools: uniqueTools(
        INSPECTION_TOOLS,
        SPEC_WORKFLOW_TOOLS,
        SPEC_FINALIZATION_CONTROL_TOOLS,
        SWORM_READ_STATUS_TOOLS
      ),
      optionalTools: [],
      blockedTools: RAW_FILE_MUTATION_TOOLS,
      onlyAllowedTools: SPEC_AUTHORING_ALL_TOOLS
    },
    mutation: AUTHORING_MUTATION,
    lease: WORKFLOW_RUN_LEASE,
    recovery: STANDARD_RECOVERY
  }),
  profile({
    id: 'spec-working',
    owner: 'spec',
    phase: 'implementation',
    label: 'Spec working',
    statusKey: 'spec-workflow',
    toolAccess: additiveToolAccess(uniqueTools(IMPLEMENTATION_CORE_TOOLS, RAW_FILE_MUTATION_TOOLS, SWORM_TOOLS), [
      'ask_user',
      'AskClaude',
      'subagent',
      'web_search',
      'code_search',
      'fetch_content',
      'get_search_content'
    ]),
    mutation: IMPLEMENTATION_MUTATION,
    lease: WORKFLOW_RUN_LEASE,
    recovery: STANDARD_RECOVERY
  }),
  profile({
    id: 'plan-review-authoring',
    owner: 'plan-review',
    phase: 'authoring',
    label: 'Plan review authoring',
    statusKey: 'spec-workflow',
    toolAccess: exclusiveToolAccess(uniqueTools(INSPECTION_TOOLS, PLAN_WORKFLOW_TOOLS), [], RAW_FILE_MUTATION_TOOLS),
    mutation: REVIEW_AUTHORING_MUTATION,
    lease: WORKFLOW_RUN_LEASE,
    recovery: STANDARD_RECOVERY
  }),
  profile({
    id: 'cleanup',
    owner: 'cleanup',
    phase: 'implementation',
    label: 'Cleanup',
    statusKey: 'cleanup-workflow',
    toolAccess: additiveToolAccess(
      ['bash', 'read', 'grep', 'find', 'ls', 'subagent', 'edit', 'write'],
      ['ask_user', 'AskClaude']
    ),
    mutation: IMPLEMENTATION_MUTATION,
    lease: WORKFLOW_RUN_LEASE,
    recovery: STANDARD_RECOVERY
  }),
  // Handoff is a controller phase, not an LLM capability profile. It carries
  // lease/recovery/mutation policy for local queue transfer work.
  profile({
    id: 'handoff',
    owner: 'workflow',
    phase: 'handoff',
    label: 'Workflow handoff',
    statusKey: 'workflow-handoff',
    toolAccess: exclusiveToolAccess([], [], RAW_FILE_MUTATION_TOOLS),
    mutation: HANDOFF_MUTATION,
    lease: WORKFLOW_RUN_LEASE,
    recovery: STANDARD_RECOVERY
  })
] as const satisfies readonly WorkflowProfile[]

export function getWorkflowProfile(id: WorkflowId): WorkflowProfile {
  const found = WORKFLOW_PROFILES.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`Unknown workflow profile: ${id}`)
  return found
}

export function getProfileToolNames(profile: WorkflowProfile): readonly string[] {
  return uniqueTools(profile.toolAccess.needsTools, profile.toolAccess.optionalTools)
}
