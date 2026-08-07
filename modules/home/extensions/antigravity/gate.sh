#!/bin/sh
# PI_AGY_GATE_V1 — PreToolUse gate for the Pi Antigravity provider.
#
# AGY hooks are global: this file runs for every `agy` process on the machine,
# interactive sessions included. It therefore scopes itself to Pi and is inert
# everywhere else.
#
# AGY settings grant only mcp(pi/*). This hook is an independent deny-list:
# silence leaves allowed Pi MCP calls to the normal permission engine, while a
# deny blocks every builtin and foreign MCP server even if settings drift.
#
# Installed by Nix at ~/.gemini/config/hooks.json, which is the only location
# AGY actually executes hooks from.

# Not a Pi-spawned process: leave stdin unread and interactive agy untouched.
[ "${PI_AGY_GATE:-}" = 1 ] || exit 0

POLICY_FIELDS=$(@jq@ -er '
  [
    (.toolCall.name | strings),
    (.toolCall.args | if type == "object" then (.ServerName // .serverName // .server_name // "") else "" end | strings)
  ]
  | @tsv
' 2>/dev/null) || POLICY_FIELDS=
TAB=$(printf '\t')
TOOL_NAME=${POLICY_FIELDS%%"$TAB"*}
SERVER_NAME=${POLICY_FIELDS#*"$TAB"}

# call_mcp_tool dispatches to every global or workspace MCP server AGY loaded.
# Only Pi's server belongs to this provider; all others bypass Pi's tool loop.
if [ "$TOOL_NAME" = call_mcp_tool ]; then
  case "$SERVER_NAME" in
    @server@|'"@server@"')
      exit 0
      ;;
  esac
fi

# Pi's direct MCP tools and inert control tools; @allowed@ is substituted from
# allowed-tools.json, the same source gate.ts checks. The generic MCP dispatcher
# was handled above and must not fall through its allowlist entry.
case "$TOOL_NAME" in
  call_mcp_tool)
    ;;
  @allowed@)
    exit 0
    ;;
esac

printf '%s\n' '{"decision":"deny","reason":"BLOCKED_BY_PI: only tools served by Pi are available in this environment."}'
