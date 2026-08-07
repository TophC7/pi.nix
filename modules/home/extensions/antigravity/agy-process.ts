import { NdjsonProcess, type NdjsonProcessOptions } from '@pi/lib/provider/ndjson-process'

// AGY's stream-json envelope. The discriminator is `event`, not `type`:
//   {"event":"init","conversation_id":...,"init":{...}}
//   {"event":"step_update","step_update":{...}}
//   {"event":"result","result":{...}}
export type AgyMessage = {
  event: string
  [key: string]: any
}

// One `agy --print` process per Pi turn. AGY runs its own agent loop inside it,
// so this process outlives a single streamSimple call and is iterated once for
// the whole turn.
export class AgyProcess extends NdjsonProcess<AgyMessage> {
  constructor(options: Omit<NdjsonProcessOptions, 'displayName' | 'writableStdin' | 'onStderr'>) {
    super({ ...options, displayName: 'agy' })
  }
}
