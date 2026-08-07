#!/bin/sh
# PI_AGY_GATE_V1 — PreToolUse gate for the Pi Antigravity provider.
#
# AGY hooks are global: this file runs for every `agy` process on the machine,
# interactive sessions included. It therefore scopes itself to Pi and is inert
# everywhere else.
#
# Pi's provider passes --dangerously-skip-permissions, because headless print
# mode auto-denies MCP calls and a hook cannot grant permission: `decision:
# "allow"` fires and is then overruled by the permission check. Only `deny`
# works. So this gate is a deny-list, and its permit is *silence* — printing
# nothing lets the flag carry the call through.
#
# Installed by Nix at ~/.gemini/config/hooks.json, which is the only location
# AGY actually executes hooks from.

# Not a Pi-spawned process: leave stdin unread and interactive agy untouched.
[ "${PI_AGY_GATE:-}" = 1 ] || exit 0

TOOL_NAME=$(@jq@ -er '.toolCall.name | strings' 2>/dev/null) || TOOL_NAME=

# Pi's own MCP dispatcher and the inert control tools; @allowed@ is substituted
# at build time from allowed-tools.json, the same source gate.ts checks against.
# Everything else — every filesystem, shell, browser, web, memory, and subagent
# built-in — is denied, so the model can only act through tools Pi executes and
# records.
case "$TOOL_NAME" in
  @allowed@)
    exit 0
    ;;
esac

printf '%s\n' '{"decision":"deny","reason":"BLOCKED_BY_PI: built-in tools are disabled in this environment. Use the pi MCP tools instead."}'
