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
  extensionFiles = [
    "caveman.ts"
    "clear.ts"
    "use-fish.ts"
  ];
  piPackages = import ./packages.nix {
    inherit lib pkgs inputs;
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
    ];

    home.file = builtins.listToAttrs (map (name: {
      name = ".pi/agent/extensions/${name}";
      value.source = ./extensions/${name};
    }) extensionFiles) // {
      ".pi/agent/settings.json".text = builtins.toJSON {
        defaultProvider = cfg.provider;
        defaultModel = cfg.model;
        defaultThinkingLevel = "medium";
        theme = "dark";

        extensions = map (name: "~/.pi/agent/extensions/${name}") extensionFiles;

        packages = map toString [
          inputs.pi-ask-user
          inputs.pi-subagents
          inputs.pi-simplify
          inputs.pi-rtk-optimizer
          piPackages.pi-claude-bridge
          piPackages.pi-web-access
          piPackages.context-mode
        ];
      };
    };
  };
}
