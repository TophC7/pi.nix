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
  piPackages = import ./packages.nix {
    inherit lib pkgs inputs;
  };
in
{
  options.programs.pi = {
    enable = lib.mkEnableOption "Pi coding agent configuration";

    provider = lib.mkOption {
      type = lib.types.str;
      default = "google-gemini-cli";
      description = "Default LLM provider.";
    };

    model = lib.mkOption {
      type = lib.types.str;
      default = "gemini-3.1-pro-preview";
      description = "Default LLM model.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.file = {
      ".pi/agent/extensions/caveman.ts".source = ./extensions/caveman.ts;
      ".pi/agent/extensions/clear.ts".source = ./extensions/clear.ts;
      ".pi/agent/extensions/use-fish.ts".source = ./extensions/use-fish.ts;
    };

    home.file.".pi/agent/settings.json".text = builtins.toJSON {
      defaultProvider = cfg.provider;
      defaultModel = cfg.model;
      defaultThinkingLevel = "medium";
      theme = "dark";

      extensions = [
        "~/.pi/agent/extensions/caveman.ts"
        "~/.pi/agent/extensions/clear.ts"
        "~/.pi/agent/extensions/use-fish.ts"
      ];

      packages = map toString [
        inputs.pi-ask-user
        inputs.pi-subagents
        inputs.pi-simplify
        inputs.pi-rtk-optimizer
        piPackages.pi-web-access
        piPackages.context-mode
      ];
    };
  };
}
