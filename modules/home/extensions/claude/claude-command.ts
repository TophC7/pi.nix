const BLOCKED_ENVIRONMENT_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_SAFE_MODE',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX'
] as const

export function claudeEnvironment(
  inherited: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ...inherited,
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
    CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
    DISABLE_AUTO_COMPACT: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: '0',
    // Pi executes every tool itself. Claude's deferred MCP tool search hides
    // large catalogs behind ToolSearch instead of emitting Pi tool calls.
    ENABLE_TOOL_SEARCH: 'false'
  }
  for (const variable of BLOCKED_ENVIRONMENT_VARIABLES) delete environment[variable]
  return environment
}

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
    options.model
  ]

  if (options.effort) args.push('--effort', options.effort, '--thinking-display', 'summarized')
  if (options.resume) args.push('--resume', options.resume)
  if (options.mcpConfig) args.push('--mcp-config', options.mcpConfig)
  if (options.persistSession === false) args.push('--no-session-persistence')
  if (options.maxTurns) args.push('--max-turns', String(options.maxTurns))
  return args
}
