export const PI_LIB_PACKAGE = '@pi/lib' as const

// Pi auto-discovers every directory under ~/.pi/agent/extensions/ and tries to
// invoke its default export as an extension factory. pi-lib is a support-only
// library, so register a no-op factory to satisfy the loader.
export default () => {}

export * from './command.ts'
export * from './extension.ts'
export type {
  HandoffContext,
  HandoffOptions,
  HandoffPolicy
} from './handoff/index.ts'
export { deferToAgentEnd, handoff } from './handoff/index.ts'
export * from './subagents/index.ts'
export * from './ui/index.ts'
export * from './workflow/index.ts'
