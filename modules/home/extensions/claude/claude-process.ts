export type ClaudeMessage = {
  type: string
  subtype?: string
  [key: string]: any
}

const MAX_NDJSON_LINE_LENGTH = 16 * 1024 * 1024

export class ClaudeProcess implements AsyncIterable<ClaudeMessage> {
  readonly child: ReturnType<typeof Bun.spawn>
  private input: FileSink
  private writeChain: Promise<void> = Promise.resolve()
  private stderr = ''
  private closeError: Error | null = null

  constructor(options: {
    executable: string
    args: string[]
    cwd: string
    env: Record<string, string | undefined>
    onStderr?: (data: string) => void
  }) {
    const env = Object.fromEntries(
      Object.entries(options.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    )
    this.child = Bun.spawn([options.executable, ...options.args], {
      cwd: options.cwd,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this.input = this.child.stdin
    void this.captureStderr(options.onStderr).catch((error) => {
      this.appendStderr(`stderr capture failed: ${String(error)}`)
    })
  }

  send(message: ClaudeMessage): Promise<void> {
    const line = `${JSON.stringify(message)}\n`
    const write = this.writeChain.then(async () => {
      this.input.write(line)
      await this.input.flush()
    })
    this.writeChain = write.catch(() => undefined)
    return write
  }

  endInput(): void {
    void this.writeChain.finally(() => this.input.end())
  }

  async interrupt(): Promise<void> {
    this.child.kill('SIGINT')
  }

  close(error?: Error): void {
    if (error) this.closeError = error
    if (this.child.exitCode === null) this.child.kill('SIGKILL')
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ClaudeMessage> {
    const reader = this.child.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        this.assertLineSize(line)
        if (line.trim()) yield this.parseLine(line)
      }
      this.assertLineSize(buffer)
      if (done) break
    }

    if (buffer.trim()) yield this.parseLine(buffer)
    const exitCode = await this.child.exited
    if (exitCode !== 0) {
      throw (
        this.closeError ??
        new Error(
          this.stderr.trim() || `Claude Code exited with status ${exitCode}`,
        )
      )
    }
  }

  private assertLineSize(line: string): void {
    if (line.length <= MAX_NDJSON_LINE_LENGTH) return
    const error = new Error(
      `Claude Code emitted an NDJSON line exceeding ${MAX_NDJSON_LINE_LENGTH} characters`,
    )
    this.close(error)
    throw error
  }

  private parseLine(line: string): ClaudeMessage {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error(`Claude Code emitted invalid JSON: ${line.slice(0, 500)}`)
    }
  }

  private async captureStderr(
    onStderr?: (data: string) => void,
  ): Promise<void> {
    const reader = this.child.stderr.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const data = decoder.decode(value, { stream: true })
      this.appendStderr(data)
      try {
        onStderr?.(data)
      } catch (error) {
        this.appendStderr(`stderr callback failed: ${String(error)}`)
      }
    }
    this.appendStderr(decoder.decode())
  }

  private appendStderr(data: string): void {
    const limit = 64 * 1024
    this.stderr = `${this.stderr}${data}`.slice(-limit)
  }
}
