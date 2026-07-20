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

    # Intentionally NOT following our nixpkgs. llm-agents pins its own, newer
    # nixpkgs; forcing our older mix.nix one breaks eval of its package set
    # (e.g. vessel-browser wants electron_42). Pi is a JS tool we rewrap against
    # our own Bun, so its runtime closure is unaffected.
    llm-agents.url = "github:numtide/llm-agents.nix";

    bun2nix.follows = "llm-agents/bun2nix";

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
    in
    {
      homeManagerModules = {
        pi = import ./modules/home {
          inherit lib inputs;
        };
        default = self.homeManagerModules.pi;
      };

      packages = nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (
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
    };
}
