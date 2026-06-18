import type { TerminalInputHandler, Theme, ThemeColor } from '@earendil-works/pi-coding-agent'

export interface RgbColor {
  readonly r: number
  readonly g: number
  readonly b: number
}

export type ThinkingLevelName = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

type RgbResult = RgbColor | undefined

type PendingQuery = {
  readonly kind: 'palette' | 'background'
  readonly key: number | 'background'
  readonly resolve: (value: RgbResult) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export interface OscColorQueryOptions {
  readonly onInput: (handler: TerminalInputHandler) => () => void
  readonly write?: (text: string) => void
  readonly timeoutMs?: number
}

export class OscColorQuery {
  private pending: PendingQuery[] = []
  private buffer = ''
  private readonly unsubscribe: () => void
  private readonly write: (text: string) => void
  private readonly timeoutMs: number

  constructor(options: OscColorQueryOptions) {
    this.write = options.write ?? writeTerminal
    this.timeoutMs = Math.max(25, options.timeoutMs ?? 180)
    this.unsubscribe = options.onInput((data) => this.handleInput(data))
  }

  dispose(): void {
    this.unsubscribe()
    for (const query of this.pending) {
      clearTimeout(query.timer)
      query.resolve(undefined)
    }
    this.pending = []
    this.buffer = ''
  }

  queryPalette(index: number): Promise<RgbResult> {
    const safeIndex = Math.max(0, Math.min(255, Math.floor(index)))
    return this.enqueue('palette', safeIndex, `\x1b]4;${safeIndex};?\x07`)
  }

  queryBackground(): Promise<RgbResult> {
    return this.enqueue('background', 'background', '\x1b]11;?\x07')
  }

  private enqueue(kind: PendingQuery['kind'], key: PendingQuery['key'], request: string): Promise<RgbResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((entry) => entry.resolve !== resolve)
        resolve(undefined)
      }, this.timeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
      this.pending.push({ kind, key, resolve, timer })
      this.write(request)
    })
  }

  private handleInput(data: string): ReturnType<TerminalInputHandler> {
    if (!data.includes('\x1b]') && !this.buffer) return undefined
    this.buffer = `${this.buffer}${data}`.slice(-2048)
    let consumed = false
    for (;;) {
      const match = parseOscColorResponse(this.buffer)
      if (!match) break
      consumed = true
      this.resolveMatch(match)
      this.buffer = this.buffer.slice(match.end)
    }
    if (this.buffer.length > 1024 && !this.buffer.includes('\x1b]')) this.buffer = ''
    return consumed || data.startsWith('\x1b]') ? { consume: true } : undefined
  }

  private resolveMatch(match: OscColorResponse): void {
    const index = this.pending.findIndex((entry) => {
      if (match.kind === 'palette') return entry.kind === 'palette' && entry.key === match.index
      return entry.kind === 'background'
    })
    if (index < 0) return
    const [entry] = this.pending.splice(index, 1)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.resolve(match.rgb)
  }
}

interface OscColorResponse {
  readonly kind: 'palette' | 'background'
  readonly index?: number
  readonly rgb: RgbResult
  readonly end: number
}

function parseOscColorResponse(buffer: string): OscColorResponse | undefined {
  const start = buffer.indexOf('\x1b]')
  if (start < 0) return undefined
  const endBel = buffer.indexOf('\x07', start)
  const endSt = buffer.indexOf('\x1b\\', start)
  const end = endBel >= 0 && (endSt < 0 || endBel < endSt) ? endBel + 1 : endSt >= 0 ? endSt + 2 : -1
  if (end < 0) return undefined
  const payload = buffer.slice(start + 2, endBel >= 0 && endBel + 1 === end ? end - 1 : end - 2)
  const palette = payload.match(/^4;(\d+);(.+)$/)
  if (palette) {
    const rgb = parseTerminalRgb(palette[2]!)
    return { kind: 'palette', index: Number(palette[1]), rgb, end }
  }
  const background = payload.match(/^11;(.+)$/)
  if (background) {
    const rgb = parseTerminalRgb(background[1]!)
    return { kind: 'background', rgb, end }
  }
  return undefined
}

function parseTerminalRgb(value: string): RgbColor | undefined {
  const rgb = value.match(/^rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})$/)
  if (rgb) {
    return {
      r: componentToByte(rgb[1]!),
      g: componentToByte(rgb[2]!),
      b: componentToByte(rgb[3]!)
    }
  }
  const hex = value.match(/^#?([0-9a-fA-F]{6})$/)
  if (hex) return hexToRgb(`#${hex[1]}`)
  return undefined
}

function componentToByte(value: string): number {
  const max = (1 << (value.length * 4)) - 1
  return clampByte(Math.round((Number.parseInt(value, 16) / max) * 255))
}

function writeTerminal(text: string): void {
  const stream = process.stdout.isTTY ? process.stdout : process.stderr
  stream.write(text)
}

export interface ThinkingTonePainterOptions extends OscColorQueryOptions {
  readonly baseColor?: ThemeColor
  readonly onResolved?: () => void
}

export class ThinkingTonePainter {
  private readonly query: OscColorQuery
  private readonly baseColor: ThemeColor
  private readonly onResolved?: () => void
  private background: RgbColor | undefined
  private cacheKey = ''
  private palette: Record<ThinkingLevelName, string> | undefined
  private resolving = false

  constructor(options: ThinkingTonePainterOptions) {
    this.query = new OscColorQuery(options)
    this.baseColor = options.baseColor ?? 'thinkingXhigh'
    this.onResolved = options.onResolved
  }

  dispose(): void {
    this.query.dispose()
  }

  paint(theme: Theme, level: string | undefined | null, text: string): string {
    const normalized = normalizeThinking(level)
    const fallback = theme.getThinkingBorderColor(normalized)(text)
    const key = themeKey(theme, this.baseColor)
    if (this.cacheKey !== key) {
      this.cacheKey = key
      this.palette = undefined
      this.background = undefined
      void this.resolve(theme, key)
    }
    const sgr = this.palette?.[normalized]
    return sgr ? `${sgr}${text}\x1b[39m` : fallback
  }

  private async resolve(theme: Theme, key: string): Promise<void> {
    if (this.resolving) return
    this.resolving = true
    try {
      const backgroundPromise = this.query.queryBackground()
      const base = await resolveThemeRgb(theme, this.baseColor, this.query)
      const background = await backgroundPromise
      if (!base || this.cacheKey !== key) return
      this.background = background ?? this.background ?? { r: 0, g: 0, b: 0 }
      if (this.cacheKey !== key) return
      this.palette = makeThinkingToneSgr(base, this.background)
      this.onResolved?.()
    } finally {
      this.resolving = false
    }
  }
}

function normalizeThinking(level: string | undefined | null): ThinkingLevelName {
  if (level === 'minimal' || level === 'low' || level === 'medium' || level === 'high' || level === 'xhigh')
    return level
  return 'off'
}

function themeKey(theme: Theme, color: ThemeColor): string {
  try {
    return `${theme.name ?? ''}:${theme.getColorMode()}:${theme.getFgAnsi(color)}`
  } catch {
    return `${theme.name ?? ''}:unknown`
  }
}

async function resolveThemeRgb(theme: Theme, color: ThemeColor, query: OscColorQuery): Promise<RgbColor | undefined> {
  let ansi: string
  try {
    ansi = theme.getFgAnsi(color)
  } catch {
    return undefined
  }
  const direct = parseTruecolorAnsi(ansi)
  if (direct) return direct
  const indexed = parseIndexedAnsi(ansi)
  if (indexed === undefined) return undefined
  if (indexed < 16) return (await query.queryPalette(indexed)) ?? xterm256ToRgb(indexed)
  return xterm256ToRgb(indexed)
}

function parseTruecolorAnsi(ansi: string): RgbColor | undefined {
  const match = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/)
  if (!match) return undefined
  return {
    r: clampByte(Number(match[1])),
    g: clampByte(Number(match[2])),
    b: clampByte(Number(match[3]))
  }
}

function parseIndexedAnsi(ansi: string): number | undefined {
  const extended = ansi.match(/\x1b\[38;5;(\d+)m/)
  if (extended) return clampByte(Number(extended[1]))
  const basic = ansi.match(/\x1b\[(?:[0-9;]*;)?(3[0-7]|9[0-7])m/)
  if (!basic) return undefined
  const code = Number(basic[1])
  if (code >= 30 && code <= 37) return code - 30
  return code - 90 + 8
}

function makeThinkingToneSgr(base: RgbColor, background: RgbColor): Record<ThinkingLevelName, string> {
  const dark = relativeLuminance(background) < 0.45
  const quiet = mix(background, base, dark ? 0.36 : 0.3)
  const low = mix(background, base, dark ? 0.56 : 0.5)
  const medium = mix(background, base, dark ? 0.76 : 0.68)
  const high = mix(background, base, dark ? 0.94 : 0.86)
  const xhigh = dark ? mix(base, { r: 255, g: 255, b: 255 }, 0.24) : mix(base, { r: 0, g: 0, b: 0 }, 0.22)
  return {
    off: sgr(mix(background, { r: 128, g: 128, b: 128 }, dark ? 0.45 : 0.35)),
    minimal: sgr(quiet),
    low: sgr(low),
    medium: sgr(medium),
    high: sgr(high),
    xhigh: sgr(xhigh)
  }
}

function sgr(rgb: RgbColor): string {
  return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`
}

function mix(a: RgbColor, b: RgbColor, amount: number): RgbColor {
  const t = Math.max(0, Math.min(1, amount))
  return {
    r: clampByte(a.r + (b.r - a.r) * t),
    g: clampByte(a.g + (b.g - a.g) * t),
    b: clampByte(a.b + (b.b - a.b) * t)
  }
}

function relativeLuminance(color: RgbColor): number {
  const channel = (value: number) => {
    const srgb = value / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

function hexToRgb(hex: string): RgbColor | undefined {
  const match = hex.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/)
  if (!match) return undefined
  return {
    r: Number.parseInt(match[1]!, 16),
    g: Number.parseInt(match[2]!, 16),
    b: Number.parseInt(match[3]!, 16)
  }
}

function xterm256ToRgb(index: number): RgbColor {
  const safe = Math.max(0, Math.min(255, Math.floor(index)))
  const basic = [
    '#000000',
    '#800000',
    '#008000',
    '#808000',
    '#000080',
    '#800080',
    '#008080',
    '#c0c0c0',
    '#808080',
    '#ff0000',
    '#00ff00',
    '#ffff00',
    '#0000ff',
    '#ff00ff',
    '#00ffff',
    '#ffffff'
  ]
  if (safe < 16) return hexToRgb(basic[safe]!)!
  if (safe < 232) {
    const cube = safe - 16
    const level = (n: number) => (n === 0 ? 0 : 55 + n * 40)
    return {
      r: level(Math.floor(cube / 36)),
      g: level(Math.floor((cube % 36) / 6)),
      b: level(cube % 6)
    }
  }
  const gray = 8 + (safe - 232) * 10
  return { r: gray, g: gray, b: gray }
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}
