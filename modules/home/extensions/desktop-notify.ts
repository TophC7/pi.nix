import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'

const execFileAsync = promisify(execFile)
const APP_NAME = 'Pi'
const NOTIFY_SEND = 'notify-send'
const TIMEOUT_MS = Number(process.env.PI_NOTIFY_TIMEOUT_MS ?? 2500)
const EXPIRE_MS = Number(process.env.PI_NOTIFY_EXPIRE_MS ?? 5000)

type Urgency = 'low' | 'normal' | 'critical'

type Notification = {
  title: string
  body: string
  urgency?: Urgency
}

let notifierFailureWarned = false
let lastNotificationKey = ''
let lastNotificationAt = 0

function enabled(): boolean {
  const value = process.env.PI_DESKTOP_NOTIFY
  return value !== '0' && value !== 'false' && value !== 'off'
}

function expireMs(): string | undefined {
  return Number.isFinite(EXPIRE_MS) && EXPIRE_MS > 0 ? String(EXPIRE_MS) : undefined
}

function notificationArgs(notification: Notification): string[] {
  const expire = expireMs()
  return [
    '--app-name',
    APP_NAME,
    '--urgency',
    notification.urgency ?? 'normal',
    ...(expire ? ['--expire-time', expire] : []),
    '--icon',
    'utilities-terminal',
    notification.title,
    notification.body
  ]
}

function shouldDeduplicate(notification: Notification): boolean {
  const now = Date.now()
  const key = `${notification.title}\n${notification.body}\n${notification.urgency ?? 'normal'}`
  const duplicate = key === lastNotificationKey && now - lastNotificationAt < 1500
  lastNotificationKey = key
  lastNotificationAt = now
  return duplicate
}

async function notifyDesktop(notification: Notification, ctx?: ExtensionContext): Promise<void> {
  if (!enabled() || shouldDeduplicate(notification)) return

  try {
    await execFileAsync(NOTIFY_SEND, notificationArgs(notification), {
      timeout: TIMEOUT_MS
    })
  } catch (error) {
    warnNotifierFailure(error, ctx)
  }
}

function warnNotifierFailure(error: unknown, ctx?: ExtensionContext): void {
  if (notifierFailureWarned || !ctx?.hasUI) return
  notifierFailureWarned = true
  const message =
    error instanceof Error && error.message ? `notify-send failed: ${error.message}` : 'notify-send failed'
  ctx.ui.notify(message, 'warning')
}

function truncateText(text: string, maxLength = 180): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text
}

function shortToolError(event: { toolName: string; result: unknown }): string {
  const result = event.result as { content?: Array<{ type?: string; text?: string }> } | undefined
  const text = result?.content?.find((item) => item?.type === 'text')?.text?.trim()
  if (!text) return `${event.toolName} failed`
  const firstLine = text.split('\n').find(Boolean) ?? `${event.toolName} failed`
  return truncateText(firstLine)
}

function shortAskQuestion(args: unknown): string {
  const question = (args as { question?: unknown } | undefined)?.question
  return typeof question === 'string' && question.trim() ? truncateText(question.trim()) : 'Agent needs input'
}

export default function (pi: ExtensionAPI) {
  let startedAt = 0
  let toolErrorCount = 0
  let providerErrorCount = 0
  let firstError = ''

  pi.registerCommand('desktop-notify-test', {
    description: 'Send test Linux desktop notification',
    handler: async (_args, ctx) => {
      await notifyDesktop(
        {
          title: 'Pi',
          body: 'Desktop notifications working',
          urgency: 'normal'
        },
        ctx
      )
    }
  })

  pi.on('agent_start', async () => {
    startedAt = Date.now()
    toolErrorCount = 0
    providerErrorCount = 0
    firstError = ''
  })

  pi.on('after_provider_response', async (event) => {
    if (event.status < 400) return
    providerErrorCount++
    firstError ||= `Provider HTTP ${event.status}`
  })

  pi.on('tool_execution_start', async (event, ctx) => {
    if (event.toolName !== 'ask_user') return
    await notifyDesktop(
      {
        title: 'Pi needs input',
        body: shortAskQuestion(event.args),
        urgency: 'normal'
      },
      ctx
    )
  })

  pi.on('tool_execution_end', async (event) => {
    if (!event.isError) return
    toolErrorCount++
    const body = shortToolError(event)
    firstError ||= body
  })

  pi.on('agent_end', async (_event, ctx) => {
    const elapsedSeconds = startedAt ? Math.max(1, Math.round((Date.now() - startedAt) / 1000)) : 0
    const suffix = elapsedSeconds ? ` (${elapsedSeconds}s)` : ''
    const totalErrors = toolErrorCount + providerErrorCount

    if (totalErrors > 0) {
      await notifyDesktop(
        {
          title: 'Pi done: errors',
          body: `${totalErrors} error(s). ${firstError}${suffix}`,
          urgency: 'normal'
        },
        ctx
      )
      return
    }

    if (ctx.hasPendingMessages()) {
      await notifyDesktop(
        {
          title: 'Pi done',
          body: `Follow-up queued${suffix}`,
          urgency: 'normal'
        },
        ctx
      )
      return
    }

    await notifyDesktop({ title: 'Pi done', body: `Agent finished${suffix}`, urgency: 'normal' }, ctx)
  })
}
