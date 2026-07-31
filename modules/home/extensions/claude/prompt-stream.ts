import type { ClaudeMessage, ClaudeProcess } from './claude-process.js'

export type InputContent =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: {
        type: 'base64'
        media_type: string
        data: string
      }
    }

export interface PromptStream {
  attach: (process: ClaudeProcess) => void
  push: (message: ClaudeMessage) => Promise<void>
  end: () => void
  fail: (error: Error) => void
}

export function makePromptStream(): PromptStream {
  type Pending = {
    message: ClaudeMessage
    resolve: () => void
    reject: (error: Error) => void
  }

  let process: ClaudeProcess | null = null
  let closed = false
  let failure: Error | null = null
  let chain = Promise.resolve()
  const pending: Pending[] = []

  const schedule = (item: Pending) => {
    const attachedProcess = process
    if (!attachedProcess) {
      item.reject(new Error('prompt stream is not attached'))
      return
    }
    chain = chain.then(() => attachedProcess.send(item.message)).then(item.resolve, item.reject)
  }

  return {
    attach(nextProcess) {
      if (process) throw new Error('prompt stream already attached')
      process = nextProcess
      for (const item of pending.splice(0)) schedule(item)
      if (closed) void chain.finally(() => process?.endInput())
    },
    push(message) {
      if (failure || closed) return Promise.reject(failure ?? new Error('prompt stream closed'))
      return new Promise<void>((resolve, reject) => {
        const item = { message, resolve, reject }
        if (process) schedule(item)
        else pending.push(item)
      })
    },
    end() {
      closed = true
      if (process) void chain.finally(() => process?.endInput())
    },
    fail(error) {
      failure = error
      for (const item of pending.splice(0)) item.reject(error)
      process?.close(error)
    }
  }
}

export function userMessage(content: InputContent[], priority?: 'next'): ClaudeMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {})
  }
}
