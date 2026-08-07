import { NdjsonProcess, type NdjsonProcessOptions } from '@pi/lib/provider/ndjson-process'

export type ClaudeMessage = {
  type: string
  subtype?: string
  [key: string]: any
}

export class ClaudeProcess extends NdjsonProcess<ClaudeMessage> {
  constructor(options: Omit<NdjsonProcessOptions, 'displayName' | 'writableStdin'>) {
    super({ ...options, displayName: 'Claude Code', writableStdin: true })
  }
}
