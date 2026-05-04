{
  lib,
  flake,
  inputs,
}:
{
  pkgs,
  config,
  ...
}:
let
  cfg = config.toph.agent.pi;
in
{
  options.toph.agent.pi = {
    enable = lib.mkEnableOption "Pi coding agent extensions and config";
    
    provider = lib.mkOption {
      type = lib.types.str;
      default = "google-gemini-cli";
      description = "Default LLM provider";
    };
    
    model = lib.mkOption {
      type = lib.types.str;
      default = "gemini-3.1-pro-preview";
      description = "Default LLM model";
    };
  };

  config = lib.mkIf cfg.enable {
    # Install local extensions
    home.file = {
      ".pi/agent/extensions/caveman.ts".source = ./extensions/caveman.ts;
      ".pi/agent/extensions/clear.ts".source = ./extensions/clear.ts;
      ".pi/agent/extensions/use-fish.ts".source = ./extensions/use-fish.ts;
      
      # Link remote flake inputs directly
      ".pi/agent/extensions/pi-ask-user".source = inputs.pi-ask-user;
      ".pi/agent/extensions/pi-subagents".source = inputs.pi-subagents;
      ".pi/agent/extensions/pi-simplify".source = inputs.pi-simplify;
      ".pi/agent/extensions/pi-rtk-optimizer".source = inputs.pi-rtk-optimizer;
      
      # NOTE: These two contain npm dependencies (@mozilla/readability, zod, etc.).
      # Since we are strictly linking them offline without node_modules compilation,
      # they may crash if the runner cannot resolve those libraries globally.
      ".pi/agent/extensions/pi-web-access".source = inputs.pi-web-access;
      ".pi/agent/extensions/context-mode".source = inputs.context-mode;
    };

    # Configure Pi global settings
    home.file.".pi/agent/settings.json".text = builtins.toJSON {
      defaultProvider = cfg.provider;
      defaultModel = cfg.model;
      defaultThinkingLevel = "medium";
      theme = "dark";
      
      # Load extensions
      extensions = [
        "~/.pi/agent/extensions/caveman.ts"
        "~/.pi/agent/extensions/clear.ts"
        "~/.pi/agent/extensions/use-fish.ts"
        
        # Third-party extensions
        "~/.pi/agent/extensions/pi-ask-user/index.ts"
        "~/.pi/agent/extensions/pi-subagents/index.ts"
        "~/.pi/agent/extensions/pi-simplify/index.ts"
        "~/.pi/agent/extensions/pi-rtk-optimizer/index.ts"
        
        # Heavy extensions (Dependency warning applies)
        "~/.pi/agent/extensions/pi-web-access/index.ts"
        "~/.pi/agent/extensions/context-mode/index.ts"
      ];

      # Load skills provided by these packages (if any)
      skills = [
        "~/.pi/agent/extensions/pi-ask-user/skills"
      ];
    };
  };
}
