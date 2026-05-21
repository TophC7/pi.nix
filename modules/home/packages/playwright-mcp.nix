{ pkgs, ... }:

# Nixpkgs packages @playwright/mcp with browser binaries in the store and a
# wrapper that points Playwright at those pinned browsers. Keep Pi's MCP config
# on this package path so QA never falls back to npx or global npm tooling.
pkgs.playwright-mcp
