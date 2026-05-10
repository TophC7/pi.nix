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
    use-fish.source = ./extensions/use-fish.ts;

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
    { name = "simplify"; package = inputs.pi-simplify; }
    { name = "rtk-optimizer"; package = inputs.pi-rtk-optimizer; }
    { name = "pi-terminal-theme"; package = piPackages.pi-terminal-theme; }
    { name = "pi-tool-display"; package = piPackages.pi-tool-display; }
    { name = "pi-claude-bridge"; package = piPackages.pi-claude-bridge; }
    { name = "pi-web-access"; package = piPackages.pi-web-access; }
    { name = "context-mode"; package = piPackages.context-mode; }
    { name = "token"; package = piPackages.pi-token-burden; }
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
      };
  };
}
