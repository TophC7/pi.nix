export const PI_LIB_PACKAGE = '@pi/lib' as const

// Pi auto-discovers every directory under ~/.pi/agent/extensions/ and tries to
// invoke its default export as an extension factory. pi-lib is a support-only
// library, so register a no-op factory to satisfy the loader.
export default () => {}

export * from './command.ts'
export * from './extension.ts'
export * from './agent-end.ts'
export * from './lock.ts'
export * from './rtk.ts'
export * from './subagents/index.ts'
export * from './ui/index.ts'
