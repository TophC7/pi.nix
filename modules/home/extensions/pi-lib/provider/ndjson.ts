export const DEFAULT_MAX_NDJSON_LINE_LENGTH = 16 * 1024 * 1024

/** Incremental, bounded line framing without repeatedly copying an unfinished line. */
export class NdjsonLineBuffer {
  private fragments: string[] = []
  private length = 0

  constructor(
    private readonly source: string,
    private readonly maxLineLength = DEFAULT_MAX_NDJSON_LINE_LENGTH
  ) {}

  push(chunk: string): string[] {
    const lines: string[] = []
    let start = 0
    for (let newline = chunk.indexOf('\n'); newline >= 0; newline = chunk.indexOf('\n', start)) {
      const fragment = chunk.slice(start, newline)
      this.append(fragment)
      lines.push(this.consume())
      start = newline + 1
    }
    this.append(chunk.slice(start))
    return lines
  }

  finish(): string | undefined {
    return this.length ? this.consume() : undefined
  }

  private append(fragment: string): void {
    if (!fragment) return
    this.length += fragment.length
    if (this.length > this.maxLineLength) {
      throw new Error(`${this.source} emitted an NDJSON line exceeding ${this.maxLineLength} characters`)
    }
    this.fragments.push(fragment)
  }

  private consume(): string {
    const line = this.fragments.join('')
    this.fragments = []
    this.length = 0
    return line
  }
}
