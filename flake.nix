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

    # ---------------------------------------------------------
    # Pi Package Inputs
    # ---------------------------------------------------------
    pi-ask-user = { url = "github:edlsh/pi-ask-user"; flake = false; };
    pi-subagents = { url = "github:nicobailon/pi-subagents"; flake = false; };
    pi-web-access = { url = "github:nicobailon/pi-web-access"; flake = false; };
    pi-simplify = { url = "github:geminixiang/pi-simplify"; flake = false; };
    pi-rtk-optimizer = { url = "github:MasuRii/pi-rtk-optimizer"; flake = false; };
    context-mode = { url = "github:mksglu/context-mode"; flake = false; };
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
          inherit lib;
          flake = self;
          inherit inputs;
        };
        default = self.homeManagerModules.pi;
      };

      # If we ever need to expose packages (like compiled context-mode),
      # we can use flake-utils or just nixpkgs.lib.genAttrs here later.
    };
}
