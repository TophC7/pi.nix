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

    llm-agents = {
      url = "github:numtide/llm-agents.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    bun2nix.follows = "llm-agents/bun2nix";

    # ---------------------------------------------------------
    # Pi Package Inputs
    # ---------------------------------------------------------
    pi-ask-user = {
      url = "github:edlsh/pi-ask-user";
      flake = false;
    };
    pi-subagents = {
      url = "github:nicobailon/pi-subagents";
      flake = false;
    };
    pi-web-access = {
      url = "github:nicobailon/pi-web-access";
      flake = false;
    };
    pi-simplify = {
      url = "github:geminixiang/pi-simplify";
      flake = false;
    };
    pi-rtk-optimizer = {
      url = "github:MasuRii/pi-rtk-optimizer";
      flake = false;
    };
    context-mode = {
      url = "github:mksglu/context-mode";
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
          claudeCode = inputs.llm-agents.packages.${system}.claude-code;
          piPackages = lib.fs.importAttrs ./modules/home/packages {
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
        piPackages
        // {
          default = piPackages.pi-web-access;
        }
      );
    };
}
