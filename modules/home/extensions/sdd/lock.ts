// ## LOCK ## //
// SDD-specific pieces layered on the generic pi-lib operation lock.
//
// <> activeOperation lives in @pi/lib/lock and self-clears on agent_end.
// <> draft-mode block stays here because it depends on active spec state,
//    spec frontmatter, and /spec:freehand.
// <> freehandReleased bypasses only the draft-mode block.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import {
  closeAll as closeOperationLock,
  extractPath,
  isInsideDir,
  type OperationOptions,
  type PathBlock,
  startOperation,
  getActiveOperation
} from '@pi/lib/lock'
import { getActiveCwd, getActiveSpec } from './active-spec.ts'
import { readSpec, SPEC_ROOT } from './files.ts'

export { getActiveOperation, startOperation }
export type { OperationOptions, PathBlock }

let freehandReleased = false
const draftBlockInstalled = new WeakSet<ExtensionAPI>()

export function closeAll(): void {
  closeOperationLock()
  freehandReleased = false
}

export function setFreehand(value: boolean): void {
  freehandReleased = value
}

export function getFreehand(): boolean {
  return freehandReleased
}

export interface ToolCallBlock {
  readonly block: true
  readonly reason: string
}

export function installDraftBlock(pi: ExtensionAPI): void {
  if (draftBlockInstalled.has(pi)) return
  draftBlockInstalled.add(pi)
  pi.on('tool_call', (event): ToolCallBlock | undefined => {
    const draftBlock = checkDraftBlock(event.toolName ?? '', event.input)
    if (draftBlock) return { block: true, reason: draftBlock }
    return undefined
  })
}

const WRITE_TOOLS = new Set(['write', 'edit'])

function checkDraftBlock(toolName: string, input: unknown): string | undefined {
  if (freehandReleased) return undefined
  if (!WRITE_TOOLS.has(toolName)) return undefined
  const slug = getActiveSpec()
  const cwd = getActiveCwd()
  if (!slug || !cwd) return undefined
  const spec = readSpec(cwd, slug)
  if (!spec || spec.frontmatter.status !== 'draft') return undefined
  const path = extractPath(input)
  if (!path) return undefined
  if (isInsideDir(path, SPEC_ROOT)) return undefined
  return (
    `Spec ${slug} is in draft. Writes outside ${SPEC_ROOT}/ are blocked. ` +
    `Capture the change in the spec, or run /spec:freehand to release the block, or /spec:close to exit the spec entirely.`
  )
}

// ## ALLOWED-TOOL SETS ## //
// Keep these tight. The smallest viable set is what guards us against the
// agent reaching for unrelated tools mid-operation.

export const CHECK_TOOLS: readonly string[] = [
  'read',
  'grep',
  'find',
  'ls',
  'bash',
  'subagent',
  'ask_user',
  'write'
]

export const WORK_TOOLS: readonly string[] = [
  'read',
  'grep',
  'find',
  'ls',
  'bash',
  'edit',
  'write',
  'sworm_issue_ready',
  'sworm_issue_claim',
  'sworm_issue_show',
  'sworm_issue_update',
  'sworm_comment_add',
  'sworm_dependency_list'
]

export function makeSpecPathBlock(specRoot: string): PathBlock {
  return {
    tools: new Set(['write', 'edit']),
    forbiddenPrefix: specRoot,
    reason: `Writes under ${specRoot} are blocked during spec:work; reshape intent via /spec, not /spec:work.`
  }
}
