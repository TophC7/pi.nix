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
  extensionFiles = [
    "caveman.ts"
    "clear.ts"
    "commit.ts"
    "model-picker.ts"
    "pr.ts"
    "use-fish.ts"
  ];
  extensionPaths = (map (name: "~/.pi/agent/extensions/${name}") extensionFiles) ++ [
    "~/.pi/agent/extensions/spec/index.ts"
  ];
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
in
{
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
    home.packages = [
      cfg.package
      piPackages.rtk
      piPackages.trekker
      piPackages.trekker-dashboard
      pkgs.pandoc
    ];

    home.file =
      builtins.listToAttrs (
        map (name: {
          name = ".pi/agent/extensions/${name}";
          value.source = ./extensions/${name};
        }) extensionFiles
      )
      // {
        ".pi/agent/extensions/spec".source = ./extensions/spec;
        ".pi/agent/settings.json".text = builtins.toJSON {
          defaultProvider = cfg.provider;
          defaultModel = cfg.model;
          defaultThinkingLevel = "medium";
          theme = "dark";

          extensions = extensionPaths;

          packages = map toString [
            inputs.pi-ask-user
            inputs.pi-subagents
            inputs.pi-simplify
            inputs.pi-rtk-optimizer
            piPackages.pi-terminal-theme
            piPackages.pimagotchi
            piPackages.pi-tool-display
            piPackages.pi-claude-bridge
            piPackages.pi-web-access
            piPackages.context-mode
            piPackages.pi-markdown-preview
          ];
        };
      };
  };
}
