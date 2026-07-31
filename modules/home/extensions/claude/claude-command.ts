export function claudeArguments(options: {
  model: string
  systemPrompt: string
  effort?: string
  resume?: string
  mcpConfig?: string
  persistSession?: boolean
  maxTurns?: number
}): string[] {
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--disable-slash-commands',
    '--no-chrome',
    '--tools',
    '',
    '--permission-mode',
    'bypassPermissions',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--system-prompt',
    options.systemPrompt,
    '--model',
    options.model,
  ]

  if (options.effort)
    args.push('--effort', options.effort, '--thinking-display', 'summarized')
  if (options.resume) args.push('--resume', options.resume)
  if (options.mcpConfig) args.push('--mcp-config', options.mcpConfig)
  if (options.persistSession === false) args.push('--no-session-persistence')
  if (options.maxTurns) args.push('--max-turns', String(options.maxTurns))
  return args
}
