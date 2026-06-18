// ## WORKER DISPATCH ## //
// Bridges /qa commands to Pi subagents. The command compiles/registers the run
// in the parent extension process, then this module launches a fresh agent
// context to execute the browser test instead of handing it to the main agent.

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { runtimeProfileTaskFields, type RuntimeProfile } from '@pi/lib/runtime-profile'
import { fenced } from './markdown.ts'
import { renderQaEvidenceProtocolBullets } from './prompt.ts'
import { registerActiveRun, renderRunSpec, type QaRunSpec } from './run-state.ts'
import type { QaShardSpec, QaShardStateEntry } from './shards.ts'

export const QA_WORKER_AGENT = 'agentic-qa.qa-worker'

export interface QaShardWorkerInput {
  readonly parentSpec: QaRunSpec
  readonly shard: QaShardSpec
  readonly state: QaShardStateEntry
  readonly label?: string
}

export interface PreparedQaShardWorker {
  readonly parentRunId: string
  readonly shard: QaShardSpec
  readonly state: QaShardStateEntry
  readonly childSpec: QaRunSpec
  readonly label: string
}

export function prepareQaShardWorker(input: QaShardWorkerInput): PreparedQaShardWorker {
  const childSpec = createQaShardRunSpec(input.parentSpec, input.shard, input.state)
  return {
    parentRunId: input.parentSpec.runId,
    shard: input.shard,
    state: input.state,
    childSpec,
    label: input.label ?? `/qa shard ${input.shard.shardId}`
  }
}

export function createQaShardRunSpec(parentSpec: QaRunSpec, shard: QaShardSpec, state: QaShardStateEntry): QaRunSpec {
  const relativeRunDir = `${parentSpec.relativeRunDir}/${shard.shardId}`
  return {
    target: parentSpec.target,
    mode: parentSpec.mode,
    slug: `${parentSpec.slug}-${shard.shardId}`,
    runId: state.childRunId,
    relativeRunDir,
    relativeArtifactDir: `${relativeRunDir}/artifacts`,
    setup: parentSpec.setup,
    workspaceInstructions: parentSpec.workspaceInstructions,
    scenarios: [{
      id: shard.scenarioId,
      title: shard.title,
      given: shard.given,
      when: shard.when,
      then: shard.then,
      checks: shard.checks,
      requiredEvidence: shard.requiredEvidence
    }],
    requiredEvidence: shard.requiredEvidence,
    outOfScope: [],
    sourceFiles: parentSpec.sourceFiles,
    tags: parentSpec.tags
  }
}

export function buildQaShardWorkerTask(input: PreparedQaShardWorker): string {
  const scenario = input.childSpec.scenarios[0]
  return [
    'Run exactly one agentic QA shard as an isolated Pi QA worker.',
    '',
    'You are the browser tester for this shard. The main agent is not the tester.',
    `Parent run id: ${input.parentRunId}`,
    `Child run id: ${input.childSpec.runId}`,
    `Shard id: ${input.shard.shardId}`,
    `Target: ${input.childSpec.target}`,
    `Report dir: ${input.childSpec.relativeRunDir}`,
    `Artifact dir: ${input.childSpec.relativeArtifactDir}`,
    '',
    'Required protocol:',
    `- Use child run id ${input.childSpec.runId} for qa_plan, qa_step, and qa_finish.`,
    '- Call qa_plan before any browser pass/fail claim.',
    '- Use Playwright browser tools to collect real evidence.',
    renderQaEvidenceProtocolBullets(),
    '- Environment setup has already run once before shard launch; do not start duplicate dev servers.',
    '- Treat Setup lines as context unless scenario-local setup is required for this shard.',
    '- Use qa_step after each meaningful browser assertion.',
    '- Call qa_finish exactly once for the child run id.',
    '- Do not test scenarios outside this shard.',
    '- Do not ask the main agent to do browser work.',
    input.childSpec.workspaceInstructions ? `\n${input.childSpec.workspaceInstructions}` : undefined,
    '',
    'Single-shard run spec:',
    fenced('text', renderRunSpec(input.childSpec)),
    '',
    'Scenario/check payload:',
    fenced(
      'json',
      JSON.stringify(
        {
          scenarioId: scenario?.id,
          title: scenario?.title,
          given: scenario?.given ?? [],
          when: scenario?.when ?? [],
          then: scenario?.then ?? [],
          checks: scenario?.checks ?? [],
          requiredEvidence: input.shard.requiredEvidence,
          safetyNotes: input.shard.safetyNotes
        },
        null,
        2
      )
    )
  ].join('\n')
}

export function registerQaShardWorkerRun(input: PreparedQaShardWorker): QaRunSpec {
  registerActiveRun(input.childSpec)
  return input.childSpec
}

export async function runQaShardWorkerSubagents(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  inputs: readonly PreparedQaShardWorker[],
  label: string,
  statusKey: string,
  runtimeProfile: RuntimeProfile = {}
): Promise<unknown> {
  for (const input of inputs) registerQaShardWorkerRun(input)
  const { runSubagent } = await import('@pi/lib/subagents')
  return runSubagent(
    pi,
    ctx,
    {
      tasks: inputs.map((input) => ({
        agent: QA_WORKER_AGENT,
        task: buildQaShardWorkerTask(input),
        ...runtimeProfileTaskFields(runtimeProfile)
      })),
      context: 'fresh',
      agentScope: 'both'
    },
    label,
    statusKey
  )
}
