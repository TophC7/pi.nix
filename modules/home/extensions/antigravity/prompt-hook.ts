// AGY PreInvocation hook: fetches Pi's current system prompt over the
// per-query bridge and injects it as a transient system message.

import { connectUnixSocket } from '@pi/lib/provider/mcp-transport'
import { NdjsonLineBuffer } from '@pi/lib/provider/ndjson'
import { SOCKET_ENVIRONMENT_VARIABLE, type PiToMcp } from './bridge-protocol.js'

export async function promptHookOutput(socketPath?: string): Promise<string> {
  if (!socketPath) return '{}'
  const systemPrompt = await requestSystemPrompt(socketPath)
  return JSON.stringify({ injectSteps: [{ ephemeralMessage: systemPrompt }] })
}

async function requestSystemPrompt(socketPath: string): Promise<string> {
  const socket = await connectUnixSocket(socketPath)
  return new Promise<string>((resolve, reject) => {
    const lines = new NdjsonLineBuffer('Pi prompt hook')
    let settled = false
    const finish = (error?: Error, prompt?: string) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(prompt ?? '')
    }

    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      try {
        for (const line of lines.push(chunk)) {
          if (!line.trim()) continue
          const message = JSON.parse(line) as PiToMcp
          if (message.type !== 'prompt') throw new Error('Pi bridge returned an unexpected prompt response')
          finish(undefined, message.systemPrompt)
          return
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error('Pi bridge closed before returning the system prompt')))
    socket.write('{"type":"prompt"}\n')
  })
}

if (import.meta.main) {
  try {
    console.log(await promptHookOutput(process.env[SOCKET_ENVIRONMENT_VARIABLE]))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
