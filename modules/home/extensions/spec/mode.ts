import { createAuthoringGuard } from '@pi/lib/workflow'
import { MODES, type Mode, type ModeState } from './types.ts'

type ActiveSpecMode = Exclude<Mode, 'idle'>

const guard = createAuthoringGuard<ActiveSpecMode>({
  modes: MODES.filter((mode): mode is ActiveSpecMode => mode !== 'idle'),
  statusKey: 'spec-workflow',
  statusLabel: 'Pi spec workflow'
})

export const state = guard.state as ModeState
export const setWorkflowStatus = guard.setWorkflowStatus
export const enterMode = guard.enterMode
export const exitMode = guard.exitMode
export const maybeBlockAuthoringToolCall = guard.maybeBlockAuthoringToolCall
export const setupAuthoringGuard = guard.setupAuthoringGuard
