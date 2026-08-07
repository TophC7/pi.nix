# Host configuration for the Antigravity provider.
#
# AGY reads hooks and MCP servers from ~/.gemini for every `agy` process on the
# machine, interactive sessions included. Hooks and server are inert without
# Pi's per-query bridge environment; the only shared permission is scoped to
# that `pi` MCP server.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.pi.antigravity;

  # Security policy shared by Nix, the shell gate, and the runtime guard.
  allowedTools = builtins.fromJSON (builtins.readFile ./extensions/antigravity/allowed-tools.json);
  hostPolicy = builtins.fromJSON (builtins.readFile ./extensions/antigravity/host-policy.json);
  mcpPermission = "mcp(${hostPolicy.serverName}/*)";

  # Installed with +x from a derivation rather than linked as a plain source
  # file, so the executable bit is guaranteed regardless of the checkout's mode.
  gate = pkgs.runCommand "pi-agy-gate" { } ''
    mkdir -p "$out/bin"
    substitute ${./extensions/antigravity/gate.sh} "$out/bin/pi-agy-gate" \
      --replace-fail '@jq@' '${pkgs.jq}/bin/jq' \
      --replace-fail '@allowed@' '${lib.concatStringsSep " | " allowedTools}' \
      --replace-fail '@server@' '${hostPolicy.serverName}'
    chmod 555 "$out/bin/pi-agy-gate"
  '';

  # Resolved through the extension bundle symlink. Both scripts import their
  # siblings, so they have to run from inside the bundle directory.
  extensionDirectory = "${config.home.homeDirectory}/.pi/agent/extensions/antigravity";
  mcpProcess = "${extensionDirectory}/mcp-process.ts";
  promptHookSource = "${extensionDirectory}/prompt-hook.ts";
  promptHook = pkgs.writeShellScript "pi-agy-prompt-hook" ''
    # PI_AGY_PROMPT_V1
    exec ${pkgs.bun}/bin/bun run ${lib.escapeShellArg promptHookSource}
  '';

  hooks = {
    pi-gate = {
      PreInvocation = [
        {
          type = "command";
          command = promptHook;
          timeout = 15;
        }
      ];
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

      Installs global PreInvocation and PreToolUse hooks into
      ~/.gemini/config/hooks.json. For Pi-spawned processes they inject Pi's
      system prompt and deny every AGY built-in tool, while the registered MCP
      bridge exposes Pi's tools. Also merges only mcp(pi/*) into AGY's mutable
      permission settings, avoiding blanket permission bypass. Interactive
      `agy` is otherwise unaffected because the hooks and server are inert
      without Pi's per-query environment
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

    # Both files are AGY-mutable, so read-only Home Manager symlinks would
    # freeze the user's interactive configuration. Merge only Pi's server and
    # scoped permission, preserving every unrelated setting.
    home.activation.piAntigravityRuntime = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      merge_json() {
        local config_file="$1"
        local merger="$2"
        local description="$3"
        local invalid=
        local tmp_file
        run mkdir -p "$(dirname "$config_file")"
        tmp_file="$(mktemp "$config_file.tmp.XXXXXX")"

        if [ -s "$config_file" ]; then
          "$merger" "$config_file" > "$tmp_file" || invalid=1
        else
          "$merger" --null-input > "$tmp_file" || invalid=1
        fi
        if [ -n "''${invalid:-}" ]; then
          run rm -f "$tmp_file"
          run echo "pi.nix: $config_file cannot accept $description; refusing to overwrite it" >&2
          exit 1
        fi

        if ${pkgs.diffutils}/bin/cmp -s "$tmp_file" "$config_file"; then
          run rm "$tmp_file"
        else
          run mv "$tmp_file" "$config_file"
        fi
      }

      merge_pi_server() {
        ${pkgs.jq}/bin/jq \
          --arg command "${pkgs.bun}/bin/bun" \
          --arg script "${mcpProcess}" \
          --arg server "${hostPolicy.serverName}" \
          'if type == "null" then {} elif type != "object" then error("root must be an object") else . end
           | .mcpServers = (.mcpServers // {})
           | if (.mcpServers | type) != "object" then error("mcpServers must be an object")
             else .mcpServers[$server] = { command: $command, args: ["run", $script] }
             end' \
          "$@"
      }

      merge_pi_permission() {
        ${pkgs.jq}/bin/jq \
          --arg permission "${mcpPermission}" \
          'if type == "null" then {} elif type != "object" then error("root must be an object") else . end
           | .permissions = (.permissions // {})
           | if (.permissions | type) != "object" then error("permissions must be an object")
             elif ((.permissions.allow // []) | type) != "array" then error("permissions.allow must be an array")
             else (.permissions.allow // []) as $allow
             | .permissions.allow = if $allow | index($permission) then $allow else $allow + [$permission] end
             end' \
          "$@"
      }

      merge_json \
        "${config.home.homeDirectory}/.gemini/config/mcp_config.json" \
        merge_pi_server \
        "the Pi MCP server"
      merge_json \
        "${config.home.homeDirectory}/.gemini/antigravity-cli/settings.json" \
        merge_pi_permission \
        "the scoped ${mcpPermission} permission"
    '';
  };
}
