import { SessionManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function cdExtension(pi: ExtensionAPI) {
  pi.registerCommand('cd', {
    description: 'Move current conversation to another working directory. Usage: /cd @/path',
    handler: async (args, ctx) => {
      const input = normalizePathArgument(args)
      if (!input) {
        ctx.ui.notify('Usage: /cd @/path/to/project', 'error')
        return
      }

      let targetCwd: string
      try {
        targetCwd = await resolveDirectory(input, ctx.cwd)
      } catch (error) {
        ctx.ui.notify(formatError(error), 'error')
        return
      }

      if (targetCwd === ctx.cwd) {
        ctx.ui.notify(`Already in ${targetCwd}`, 'info')
        return
      }

      await ctx.waitForIdle()

      const sourceSessionFile = ctx.sessionManager.getSessionFile()
      let targetSessionFile: string

      try {
        if (sourceSessionFile && (await Bun.file(sourceSessionFile).exists())) {
          const targetSession = SessionManager.forkFrom(sourceSessionFile, targetCwd)
          targetSessionFile = requireSessionFile(targetSession)
        } else if (ctx.sessionManager.getEntries().length === 0) {
          targetSessionFile = await createEmptySessionFile(targetCwd)
        } else {
          ctx.ui.notify(
            '/cd cannot preserve an ephemeral or not-yet-saved conversation. Start Pi with session persistence, then retry.',
            'error'
          )
          return
        }
      } catch (error) {
        ctx.ui.notify(`Could not move conversation: ${formatError(error)}`, 'error')
        return
      }

      const result = await ctx.switchSession(targetSessionFile, {
        withSession: async (newCtx) => {
          newCtx.ui.notify(`Working directory: ${newCtx.cwd}`, 'success')
        }
      })

      if (result.cancelled) {
        try {
          await Bun.file(targetSessionFile).delete()
          ctx.ui.notify('/cd cancelled', 'info')
        } catch (error) {
          ctx.ui.notify(`/cd cancelled; could not remove target session: ${formatError(error)}`, 'warning')
        }
      }
    }
  })
}

function normalizePathArgument(args: string): string | undefined {
  let value = args.trim()
  if (value.startsWith('@')) value = value.slice(1).trim()

  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1)
  }

  return value || undefined
}

async function resolveDirectory(input: string, cwd: string): Promise<string> {
  const home = Bun.env.HOME
  if ((input === '~' || input.startsWith('~/')) && !home) throw new Error('HOME is not set')

  const expanded = input === '~' ? home! : input.startsWith('~/') ? `${home}/${input.slice(2)}` : input
  const candidate = expanded.startsWith('/') ? expanded : `${cwd}/${expanded}`
  const process = Bun.spawn(['realpath', '--', candidate], {
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ])

  if (exitCode !== 0) throw new Error(stderr.trim() || `Path does not exist: ${candidate}`)

  const target = stdout.trim()
  const targetStat = await Bun.file(target).stat()
  if (!targetStat.isDirectory()) throw new Error(`Not a directory: ${target}`)
  return target
}

async function createEmptySessionFile(cwd: string): Promise<string> {
  const session = SessionManager.create(cwd)
  const sessionFile = requireSessionFile(session)
  const header = session.getHeader()
  if (!header) throw new Error('Could not create target session header')

  await Bun.write(sessionFile, `${JSON.stringify(header)}\n`)
  return sessionFile
}

function requireSessionFile(session: SessionManager): string {
  const sessionFile = session.getSessionFile()
  if (!sessionFile) throw new Error('Target session is not persistent')
  return sessionFile
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
