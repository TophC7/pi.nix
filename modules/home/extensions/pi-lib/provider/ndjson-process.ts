import { NdjsonLineBuffer } from './ndjson.js'

export type NdjsonProcessOptions = {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  displayName: string
  writableStdin?: boolean
  onStderr?: (data: string) => void
}

/** Shared subprocess lifecycle and bounded NDJSON framing for CLI providers. */
export class NdjsonProcess<Message> implements AsyncIterable<Message> {
  readonly child: ReturnType<typeof Bun.spawn>
  private readonly input: FileSink | null
  private writeChain: Promise<void> = Promise.resolve()
  private stderr = ''
  private closeError: Error | null = null

  constructor(private readonly options: NdjsonProcessOptions) {
    const env = Object.fromEntries(
      Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
    this.child = Bun.spawn([options.executable, ...options.args], {
      cwd: options.cwd,
      env,
      stdin: options.writableStdin ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    this.input = options.writableStdin ? (this.child.stdin as FileSink) : null
    void this.captureStderr().catch((error) => this.appendStderr(`stderr capture failed: ${String(error)}`))
  }

  send(message: Message): Promise<void> {
    if (!this.input) return Promise.reject(new Error(`${this.options.displayName} stdin is not writable`))
    const line = `${JSON.stringify(message)}\n`
    const write = this.writeChain.then(async () => {
      this.input!.write(line)
      await this.input!.flush()
    })
    this.writeChain = write.catch(() => undefined)
    return write
  }

  endInput(): void {
    if (this.input) void this.writeChain.finally(() => this.input!.end())
  }

  async interrupt(): Promise<void> {
    if (this.child.exitCode === null) this.child.kill('SIGINT')
  }

  close(error?: Error): void {
    if (error) this.closeError = error
    if (this.child.exitCode === null) this.child.kill('SIGKILL')
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Message> {
    const reader = this.child.stdout.getReader()
    const decoder = new TextDecoder()
    const lines = new NdjsonLineBuffer(this.options.displayName)

    while (true) {
      const { done, value } = await reader.read()
      const chunk = decoder.decode(value, { stream: !done })
      try {
        for (const line of lines.push(chunk)) {
          if (line.trim()) yield this.parseLine(line)
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.close(failure)
        throw failure
      }
      if (done) break
    }

    const tail = lines.finish()
    if (tail?.trim()) yield this.parseLine(tail)
    const exitCode = await this.child.exited
    if (exitCode !== 0) {
      throw this.closeError ?? new Error(this.stderr.trim() || `${this.options.displayName} exited with status ${exitCode}`)
    }
  }

  private parseLine(line: string): Message {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error(`${this.options.displayName} emitted invalid JSON: ${line.slice(0, 500)}`)
    }
  }

  private async captureStderr(): Promise<void> {
    const reader = this.child.stderr.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      const data = decoder.decode(value, { stream: !done })
      if (data) {
        this.appendStderr(data)
        try {
          this.options.onStderr?.(data)
        } catch (error) {
          this.appendStderr(`stderr callback failed: ${String(error)}`)
        }
      }
      if (done) return
    }
  }

  private appendStderr(data: string): void {
    this.stderr = `${this.stderr}${data}`.slice(-64 * 1024)
  }
}
