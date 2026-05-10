{
  inputs,
  lib,
  system ? builtins.currentSystem,
}:
let
  pkgs = import inputs.nixpkgs { inherit system; };
  module = import ../default.nix { inherit lib inputs; };

  hm = inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      module
      ({ ... }: {
        programs.pi.enable = true;
        home.username = "pi-extension-system-snapshot";
        home.homeDirectory = "/tmp/pi-extension-system-snapshot";
        home.stateVersion = "25.05";
      })
    ];
  };

  settings = builtins.fromJSON hm.config.home.file.".pi/agent/settings.json".text;
  homeFileNames = builtins.attrNames hm.config.home.file;
  sort = builtins.sort builtins.lessThan;
  sameSet = actual: expected: sort actual == sort expected;

  filterPrefix = prefix:
    builtins.filter (name: builtins.substring 0 (builtins.stringLength prefix) name == prefix) homeFileNames;

  expectedExtensions = [
    "~/.pi/agent/extensions/caveman.ts"
    "~/.pi/agent/extensions/clear.ts"
    "~/.pi/agent/extensions/sworm-issues.ts"
    "~/.pi/agent/extensions/use-fish.ts"
    "~/.pi/agent/extensions/git"
    "~/.pi/agent/extensions/spec/index.ts"
    "~/.pi/agent/extensions/cleanup/index.ts"
    "~/.pi/agent/extensions/subagents/index.ts"
  ];

  expectedExtensionLinks = [
    ".pi/agent/extensions/caveman.ts"
    ".pi/agent/extensions/clear.ts"
    ".pi/agent/extensions/sworm-issues.ts"
    ".pi/agent/extensions/use-fish.ts"
    ".pi/agent/extensions/git"
    ".pi/agent/extensions/node_modules/@pi/lib"
    ".pi/agent/extensions/pi-lib"
    ".pi/agent/extensions/spec"
    ".pi/agent/extensions/cleanup"
    ".pi/agent/extensions/subagents"
  ];

  expectedAgentLinks = [
    ".pi/agent/agents/cleanup/cleanup-efficiency-scout.md"
    ".pi/agent/agents/cleanup/cleanup-quality-scout.md"
    ".pi/agent/agents/cleanup/cleanup-reuse-scout.md"
    ".pi/agent/agents/spec/plan-risk-scout.md"
    ".pi/agent/agents/spec/plan-scout.md"
    ".pi/agent/agents/spec/plan-synthesizer.md"
    ".pi/agent/agents/spec/review-architecture.md"
    ".pi/agent/agents/spec/review-comment.md"
    ".pi/agent/agents/spec/review-efficiency.md"
    ".pi/agent/agents/spec/review-idiom.md"
    ".pi/agent/agents/spec/review-quality.md"
    ".pi/agent/agents/spec/review-reuse.md"
    ".pi/agent/agents/spec/spec-architect.md"
    ".pi/agent/agents/spec/spec-reviewer.md"
    ".pi/agent/agents/spec/spec-verifier.md"
  ];

  expectedPackageNames = [
    "ask-user"
    "simplify"
    "rtk-optimizer"
    "pi-terminal-theme"
    "pimagotchi"
    "pi-tool-display"
    "pi-desktop-notify"
    "pi-claude-bridge"
    "pi-web-access"
    "context-mode"
    "token"
  ];

  expectedPackages = map (name: "~/.pi/agent/packages/${name}") expectedPackageNames;
  expectedPackageLinks = map (name: ".pi/agent/packages/${name}") expectedPackageNames;

  actualExtensionLinks = filterPrefix ".pi/agent/extensions/";
  actualAgentLinks = filterPrefix ".pi/agent/agents/";
  actualPackageLinks = filterPrefix ".pi/agent/packages/";

  assertions =
    assert sameSet settings.extensions expectedExtensions
      || throw "settings.extensions logical set changed";
    assert settings.packages == expectedPackages
      || throw "settings.packages changed";
    assert sameSet actualExtensionLinks expectedExtensionLinks
      || throw "extension home.file link set changed";
    assert sameSet actualAgentLinks expectedAgentLinks
      || throw "agent home.file link set changed";
    assert sameSet actualPackageLinks expectedPackageLinks
      || throw "external package home.file link set changed";
    assert builtins.elem "~/.pi/agent/extensions/git" settings.extensions
      || throw "git extension must remain directory-shaped";
    true;
in
{
  ok = assertions;
  actual = {
    extensions = settings.extensions;
    packages = settings.packages;
    extensionLinks = actualExtensionLinks;
    agentLinks = actualAgentLinks;
    packageLinks = actualPackageLinks;
  };
}
