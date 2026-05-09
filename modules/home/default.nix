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
  # Loadable top-level extensions. Runtime support modules live beside them
  # so package-relative imports like ../workflow/recovery.ts resolve after Home Manager links.
  extensionSources = [
    "caveman.ts"
    "clear.ts"
    "sworm-issues.ts"
    "use-fish.ts"
    "git"
  ];
  supportSources = [
    "subagent-runner.ts"
    "workflow"
  ];
  # Multi-file extension packages: each owns extensions/<pkg>/index.ts and extensions/<pkg>/agents/*.md.
  # Adding a new package here auto-wires extension code, agent files, and the settings.json entry.
  extensionPackages = [
    "spec"
    "cleanup"
    "subagents"
  ];
  extensionBundle = pkgs.runCommand "pi-local-extensions" { } ''
    mkdir -p $out
    cp -R ${./extensions}/. $out/
  '';
  # Package-aware agent discovery expects ~/.pi/agent/agents/<pkg>/ to be a real
  # directory of symlinked .md files. Auto-discover file lists from source trees.
  packageAgentFiles =
    pkg:
    let
      agentsDir = ./extensions + "/${pkg}/agents";
    in
    if builtins.pathExists agentsDir then
      builtins.filter (name: lib.hasSuffix ".md" name) (builtins.attrNames (builtins.readDir agentsDir))
    else
      [ ];
  packageAgentEntries =
    pkg:
    builtins.listToAttrs (
      map (file: {
        name = ".pi/agent/agents/${pkg}/${file}";
        value.source = "${extensionBundle}/${pkg}/agents/${file}";
      }) (packageAgentFiles pkg)
    );
  agentFileLinks = lib.foldl' (acc: pkg: acc // packageAgentEntries pkg) { } extensionPackages;
  topLevelExtensionLinks = builtins.listToAttrs (
    map (name: {
      name = ".pi/agent/extensions/${name}";
      value.source = "${extensionBundle}/${name}";
    }) (extensionSources ++ supportSources)
  );
  packageExtensionLinks = builtins.listToAttrs (
    map (pkg: {
      name = ".pi/agent/extensions/${pkg}";
      value.source = "${extensionBundle}/${pkg}";
    }) extensionPackages
  );
  extensionPaths =
    (map (name: "~/.pi/agent/extensions/${name}") extensionSources)
    ++ (map (pkg: "~/.pi/agent/extensions/${pkg}/index.ts") extensionPackages);
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
  packageEntries = [
    (toString inputs.pi-ask-user)
    (toString inputs.pi-simplify)
    (toString inputs.pi-rtk-optimizer)
    (toString piPackages.pi-terminal-theme)
    (toString piPackages.pimagotchi)
    (toString piPackages.pi-tool-display)
    (toString piPackages.pi-desktop-notify)
    (toString piPackages.pi-claude-bridge)
    (toString piPackages.pi-web-access)
    (toString piPackages.context-mode)
    (toString piPackages.pi-markdown-preview)
  ];
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
      pkgs.pandoc
    ];

    home.file =
      topLevelExtensionLinks
      // packageExtensionLinks
      // agentFileLinks
      // {
        # Pi auto-loads AGENTS.md from the agent dir as global context.
        ".pi/agent/AGENTS.md".source = ./SOUL.md;
        ".pi/agent/settings.json".text = builtins.toJSON {
          defaultProvider = cfg.provider;
          defaultModel = cfg.model;
          defaultThinkingLevel = "high";
          theme = "dark";

          extensions = extensionPaths;

          packages = packageEntries;
        };
      };
  };
}
