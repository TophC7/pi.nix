{
  description = "pi.nix - Toph's pi coding agent configuration module";

  inputs = {
    nixpkgs.follows = "mix-nix/nixpkgs";

    mix-nix = {
      url = "git+file:///repo/Nix/mix.nix";
    };

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Retained for unrelated packaged agents, currently Claude Code. Pi itself
    # comes directly from the owned source fork below.
    llm-agents.url = "github:numtide/llm-agents.nix";

    bun2nix.follows = "llm-agents/bun2nix";

    pi-source.url = "git+file:///repo/pi";

    # ---------------------------------------------------------
    # Pi Package Inputs
    # ---------------------------------------------------------
    pi-ask-user = {
      url = "github:edlsh/pi-ask-user";
      flake = false;
    };
    pi-web-access = {
      url = "github:nicobailon/pi-web-access";
      flake = false;
    };
    pi-rtk-optimizer = {
      url = "github:MasuRii/pi-rtk-optimizer";
      flake = false;
    };
    pi-tool-display = {
      url = "github:MasuRii/pi-tool-display";
      flake = false;
    };
    pi-mcp-adapter = {
      url = "github:nicobailon/pi-mcp-adapter";
      flake = false;
    };
    pi-agentsmd = {
      url = "github:jvm/pi-mono";
      flake = false;
    };
    context-mode = {
      url = "github:mksglu/context-mode";
      flake = false;
    };
    impeccable = {
      url = "github:pbakaus/impeccable";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      mix-nix,
      ...
    }@inputs:
    let
      lib = mix-nix.lib;
      supportedSystems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      homeManagerModules = {
        pi = import ./modules/home {
          inherit lib inputs;
        };
        default = self.homeManagerModules.pi;
      };

      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          b2n = inputs.bun2nix.packages.${system}.default;
          lock = lib.fs.relativeTo ./locks;
          piPackages = lib.fs.importAttrs ./modules/home/packages {
            inherit
              lib
              pkgs
              inputs
              b2n
              lock
              ;
          };
        in
        piPackages
        // {
          default = piPackages.pi-web-access;
        }
      );

      apps = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          bun2nix = inputs.bun2nix.packages.${system}.default;
          update = pkgs.writeScriptBin "pi-update" ''
            #!${pkgs.fish}/bin/fish
            set -gx PATH ${
              lib.makeBinPath [
                pkgs.coreutils
                pkgs.curl
                pkgs.diffutils
                pkgs.gitMinimal
                pkgs.jq
                pkgs.nix
              ]
            } $PATH
            set -gx PI_BUN ${pkgs.bun}/bin/bun
            set -gx PI_BUN2NIX ${bun2nix}/bin/bun2nix
            set -gx PI_SOURCE_CONTEXT_MODE ${inputs.context-mode}
            set -gx PI_SOURCE_IMPECCABLE ${inputs.impeccable}
            set -gx PI_SOURCE_MCP_ADAPTER ${inputs.pi-mcp-adapter}
            set -gx PI_SOURCE_WEB_ACCESS ${inputs.pi-web-access}
            set -gx PI_SYSTEM ${system}
            exec ${pkgs.fish}/bin/fish ${./scripts/update.fish} $argv
          '';
        in
        {
          update = {
            type = "app";
            program = "${update}/bin/pi-update";
            meta.description = "Update and validate all pinned pi.nix software";
          };
        }
      );
    };
}
