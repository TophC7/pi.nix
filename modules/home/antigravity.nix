# Host configuration for the Antigravity provider.
#
# AGY has no per-project or per-invocation configuration: hooks and MCP servers
# are read from ~/.gemini and apply to every `agy` process on the machine,
# interactive sessions included. So this module writes into a second
# application's config directory, and everything it writes is shared with the
# user's own AGY usage. Both files below are scoped so that sharing is
# harmless — see AGY.md.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.pi.antigravity;

  # Single source for the gate allowlist, shared with gate.ts.
  allowedTools = builtins.fromJSON (builtins.readFile ./extensions/antigravity/allowed-tools.json);

  # Installed with +x from a derivation rather than linked as a plain source
  # file, so the executable bit is guaranteed regardless of the checkout's mode.
  gate = pkgs.runCommand "pi-agy-gate" { } ''
    mkdir -p "$out/bin"
    substitute ${./extensions/antigravity/gate.sh} "$out/bin/pi-agy-gate" \
      --replace-fail '@jq@' '${pkgs.jq}/bin/jq' \
      --replace-fail '@allowed@' '${lib.concatStringsSep " | " allowedTools}'
    chmod 555 "$out/bin/pi-agy-gate"
  '';

  # Resolved through the extension bundle symlink. mcp-process.ts imports its
  # siblings, so it has to run from inside the bundle directory.
  mcpProcess = "${config.home.homeDirectory}/.pi/agent/extensions/antigravity/mcp-process.ts";

  hooks = {
    pi-gate = {
      PreToolUse = [
        {
          matcher = "*";
          hooks = [
            {
              type = "command";
              command = "${gate}/bin/pi-agy-gate";
              timeout = 15;
            }
          ];
        }
      ];
    };
  };
in
{
  options.programs.pi.antigravity = {
    enable = lib.mkEnableOption ''
      the Antigravity model provider.

      Installs a global PreToolUse gate into ~/.gemini/config/hooks.json that
      denies every AGY built-in tool for Pi-spawned processes, and registers
      Pi's tool bridge as an MCP server. Interactive `agy` is unaffected: the
      gate is inert unless PI_AGY_GATE is set, which only Pi does
    '';
  };

  config = lib.mkIf (config.programs.pi.enable && cfg.enable) {
    # The only location AGY actually executes hooks from. ~/.gemini/hooks.json
    # and ~/.gemini/antigravity-cli/hooks.json are counted by AGY's hook-load
    # log line and then never fire.
    #
    # AGY never writes this file, so a read-only store symlink is safe. It does
    # mean Pi owns the whole file: a user hook has to be added here.
    home.file.".gemini/config/hooks.json".text = builtins.toJSON hooks;

    # mcp_config.json is AGY-mutable — the CLI rewrites it when a server is
    # added interactively — so it cannot be a read-only symlink without
    # freezing that surface. Merge one entry and leave the file writable.
    home.activation.piAntigravityMcpServer = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      config_file="${config.home.homeDirectory}/.gemini/config/mcp_config.json"
      run mkdir -p "$(dirname "$config_file")"
      tmp_file="$(mktemp "$config_file.tmp.XXXXXX")"
      trap 'rm -f "$tmp_file"' EXIT

      merge_pi_server() {
        ${pkgs.jq}/bin/jq \
          --arg command "${pkgs.bun}/bin/bun" \
          --arg script "${mcpProcess}" \
          '.mcpServers.pi = { command: $command, args: ["run", $script] }' \
          "$@"
      }

      invalid=
      if [ -s "$config_file" ]; then
        merge_pi_server "$config_file" > "$tmp_file" || invalid=1
      else
        merge_pi_server --null-input > "$tmp_file" || invalid=1
      fi
      if [ -n "$invalid" ]; then
        run echo "pi.nix: $config_file is not valid JSON; refusing to merge the Pi MCP server" >&2
        exit 1
      fi

      if ${pkgs.diffutils}/bin/cmp -s "$tmp_file" "$config_file"; then
        run rm "$tmp_file"
      else
        run mv "$tmp_file" "$config_file"
      fi
      trap - EXIT
    '';
  };
}
