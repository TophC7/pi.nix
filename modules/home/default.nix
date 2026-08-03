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
  piNodePackage = inputs.llm-agents.packages.${system}.pi;
  claudeCodePackage = inputs.llm-agents.packages.${system}.claude-code;
  piBunPackage = piNodePackage.overrideAttrs (old: {
    nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [
      pkgs.makeWrapper
      pkgs.patch
    ];

    # llm-agents now builds Pi as a standalone Bun binary. Apply our source
    # patches before that compile step so the patched behavior is embedded in
    # the binary, then wrap the resulting launcher with repo runtime defaults.
    preInstall = ''
      patch -p1 < ${./patches/pi-ai-discard-failed-tool-continuations.patch}
      patch -p1 < ${./patches/pi-tui-incremental-input-render.patch}
    '' + (old.preInstall or "");

    postInstall = (old.postInstall or "") + ''
      wrapProgram $out/bin/pi \
        --prefix PATH : ${lib.makeBinPath [ pkgs.bun pkgs.fd pkgs.ripgrep claudeCodePackage ]} \
        --set IMPECCABLE_NO_UPDATE_CHECK 1
    '';
  });
  localPackageDeclarations = {
    caveman.source = ./extensions/caveman.ts;
    cd.source = ./extensions/cd.ts;
    ponytail.source = ./extensions/ponytail.ts;
    clear.source = ./extensions/clear.ts;
    desktop-notify.source = ./extensions/desktop-notify.ts;
    sworm-issues.source = ./extensions/sworm-issues.ts;

    # Directory-shaped extension: Pi settings intentionally point at the
    # directory, not commands/index.ts.
    commands.source = ./extensions/commands;
    config = {
      source = ./extensions/config;
      entry = "index.ts";
    };

    # Runtime support modules are linked beside extension packages but are not
    # registered as extension entrypoints.
    pi-lib = {
      source = ./extensions/pi-lib;
      supportOnly = true;
    };

    # Multi-file extension packages: each owns index.ts and optional agents/*.md.
    slab = {
      source = ./extensions/slab;
      entry = "index.ts";
    };
    buddy = {
      source = lib.cleanSourceWith {
        src = ./extensions/buddy;
        filter = path: type:
          !(type == "directory" && baseNameOf path == "tests")
          && !(lib.hasInfix "/tests/" (toString path));
      };
      entry = "index.ts";
    };
    burden = {
      source = ./extensions/burden;
      entry = "index.ts";
    };
    sdd = {
      source = ./extensions/sdd;
      entry = "index.ts";
    };
    cleanup = {
      source = ./extensions/cleanup;
      entry = "index.ts";
    };
    review = {
      source = ./extensions/review;
      entry = "index.ts";
    };
    subagents = {
      source = ./extensions/subagents;
      entry = "index.ts";
    };
    claude = {
      source = ./extensions/claude;
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
      ;
  };
  externalPackageDeclarations = [
    { name = "ask-user"; package = inputs.pi-ask-user; }
    { name = "rtk-optimizer"; package = inputs.pi-rtk-optimizer; }
    # No runtime deps + loads ./index.ts directly, so the raw source input is
    # the package, same as ask-user and rtk-optimizer.
    { name = "pi-tool-display"; package = inputs.pi-tool-display; }
    { name = "pi-web-access"; package = piPackages.pi-web-access; }
    { name = "pi-agentsmd"; package = piPackages.pi-agentsmd; }
    # MCP transport for Pi. Reads ~/.pi/agent/mcp.json and registers every
    # exposed MCP tool through pi.registerTool() so the model can call them
    # like any built-in. Without this extension Pi has no MCP awareness, and
    # context-mode's `ctx_*` tools never reach the model.
    { name = "pi-mcp-adapter"; package = piPackages.pi-mcp-adapter; }
    { name = "context-mode"; package = piPackages.context-mode; }
    { name = "impeccable"; package = piPackages.impeccable; }
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
      default = piBunPackage;
      description = "Pi coding agent package to install.";
    };

    provider = lib.mkOption {
      type = lib.types.str;
      default = "openai-codex";
      description = "Default LLM provider.";
    };

    model = lib.mkOption {
      type = lib.types.str;
      default = "gpt-5.6-sol";
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
        ".pi/agent/themes/terminal.json".source = ./themes/terminal.json;

        ".pi/agent/settings.json".text = builtins.toJSON {
          defaultProvider = cfg.provider;
          defaultModel = cfg.model;
          defaultThinkingLevel = "high";
          theme = "terminal";
          quietStartup = true;

          extensions = cfg.extensionSystem.extensionPaths;

          packages = cfg.extensionSystem.packageEntries;
        };

        # MCP server registry. pi-mcp-adapter consumes this on session start
        # and registers every server's tools through pi.registerTool(). Command
        # paths come from Nix packages, so resolution does not depend on PATH,
        # npx, global npm, or runtime network fetches.
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
