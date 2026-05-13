{
  lib,
  inputs,
}:
{
  pkgs,
  config,
  ...
}:
let
  cfg = config.programs.pi;
  system = pkgs.stdenv.hostPlatform.system;
  b2n = inputs.bun2nix.packages.${system}.default;
  lock = lib.fs.relativeTo ../../locks;
  claudeCode = inputs.llm-agents.packages.${system}.claude-code;
  localPackageDeclarations = {
    caveman.source = ./extensions/caveman.ts;
    clear.source = ./extensions/clear.ts;
    desktop-notify.source = ./extensions/desktop-notify.ts;
    sworm-issues.source = ./extensions/sworm-issues.ts;

    # Directory-shaped extension: Pi settings intentionally point at the
    # directory, not git/index.ts.
    git.source = ./extensions/git;

    # Runtime support modules are linked beside extension packages but are not
    # registered as extension entrypoints.
    pi-lib = {
      source = ./extensions/pi-lib;
      supportOnly = true;
      agentsDir = null;
    };

    # Multi-file extension packages: each owns index.ts and optional agents/*.md.
    slab = {
      source = ./extensions/slab;
      entry = "index.ts";
      agentsDir = null;
    };
    burden = {
      source = ./extensions/burden;
      entry = "index.ts";
      agentsDir = null;
    };
    spec = {
      source = ./extensions/spec;
      entry = "index.ts";
    };
    cleanup = {
      source = ./extensions/cleanup;
      entry = "index.ts";
    };
    subagents = {
      source = ./extensions/subagents;
      entry = "index.ts";
    };
  };
  piPackages = lib.fs.importAttrs ./packages {
    inherit
      lib
      pkgs
      inputs
      b2n
      lock
      claudeCode
      ;
  };
  externalPackageDeclarations = [
    { name = "ask-user"; package = inputs.pi-ask-user; }
    { name = "rtk-optimizer"; package = inputs.pi-rtk-optimizer; }
    { name = "pi-tool-display"; package = piPackages.pi-tool-display; }
    { name = "pi-claude-bridge"; package = piPackages.pi-claude-bridge; }
    { name = "pi-web-access"; package = piPackages.pi-web-access; }
    # MCP transport for Pi. Reads ~/.pi/agent/mcp.json and registers every
    # exposed MCP tool through pi.registerTool() so the model can call them
    # like any built-in. Without this extension Pi has no MCP awareness, and
    # context-mode's `ctx_*` tools never reach the model.
    { name = "pi-mcp-adapter"; package = piPackages.pi-mcp-adapter; }
    { name = "context-mode"; package = piPackages.context-mode; }
    # use-fish must load last so its bash tool_call hook runs after every
    # other package's hook. In particular rtk-optimizer needs to see the raw
    # bash command (e.g. `grep -r TODO .`) before we wrap it as
    # `fish -lc '...'`; otherwise `rtk rewrite` sees `fish` as the leading
    # token and returns no-match, silently disabling every RTK rewrite.
    { name = "use-fish"; package = ./extensions/use-fish; }
  ];
in
{
  imports = [ ./lib/pi-extension-system.nix ];

  options.programs.pi = {
    enable = lib.mkEnableOption "Pi coding agent configuration";

    package = lib.mkOption {
      type = lib.types.package;
      default = inputs.llm-agents.packages.${system}.pi;
      description = "Pi coding agent package to install.";
    };

    provider = lib.mkOption {
      type = lib.types.str;
      default = "openai-codex";
      description = "Default LLM provider.";
    };

    model = lib.mkOption {
      type = lib.types.str;
      default = "gpt-5.5";
      description = "Default LLM model.";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.pi.packages = localPackageDeclarations;
    programs.pi.externalPackages = externalPackageDeclarations;

    home.packages = [
      cfg.package
      piPackages.rtk
      pkgs.libnotify # notify-send for desktop-notify.ts
      pkgs.pandoc
    ];

    home.file =
      cfg.extensionSystem.homeFiles
      // {
        # Pi auto-loads AGENTS.md from the agent dir as global context.
        ".pi/agent/AGENTS.md".source = ./SOUL.md;
        ".pi/agent/settings.json".text = builtins.toJSON {
          defaultProvider = cfg.provider;
          defaultModel = cfg.model;
          defaultThinkingLevel = "high";
          theme = "dark";

          extensions = cfg.extensionSystem.extensionPaths;

          packages = cfg.extensionSystem.packageEntries;
        };

        # MCP server registry. pi-mcp-adapter consumes this on session start
        # and registers every server's tools through pi.registerTool(). The
        # `command` is the Nix-pinned start.mjs from the context-mode build,
        # so resolution does not depend on PATH.
        ".pi/agent/mcp.json".text = builtins.toJSON {
          mcpServers = {
            context-mode = {
              command = "${pkgs.nodejs}/bin/node";
              args = [ "${piPackages.context-mode}/start.mjs" ];
              directTools = true;
              lifecycle = "keep-alive";
            };
          };
        };

        # Declarative RTK config. Pi writes the same file on first run with
        # defaults; we own it here so the `smartTruncate` and rewrite settings
        # we want survive HM activation. The /rtk TUI still works but its
        # changes will be reverted on the next switch.
        ".pi/agent/extensions/pi-rtk-optimizer/config.json".text = builtins.toJSON {
          enabled = true;
          mode = "rewrite";
          guardWhenRtkMissing = true;
          showRewriteNotifications = true;
          outputCompaction = {
            enabled = true;
            stripAnsi = true;
            readCompaction = { enabled = false; };
            sourceCodeFilteringEnabled = false;
            preserveExactSkillReads = false;
            sourceCodeFiltering = "none";
            aggregateTestOutput = true;
            filterBuildOutput = true;
            compactGitOutput = true;
            aggregateLinterOutput = true;
            groupSearchOutput = true;
            trackSavings = true;
            smartTruncate = { enabled = true; maxLines = 300; };
            truncate = { enabled = true; maxChars = 12000; };
          };
        };
      };
  };
}
