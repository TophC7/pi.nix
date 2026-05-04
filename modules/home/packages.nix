{
  lib,
  pkgs,
  inputs,
}:
let
  b2n = inputs.bun2nix.packages.${pkgs.stdenv.hostPlatform.system}.default;
  lock = lib.fs.relativeTo ../../locks;
in
{
  pi-terminal-theme = pkgs.stdenv.mkDerivation rec {
    pname = "pi-terminal-theme";
    version = "0.1.3";

    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/pi-terminal-theme/-/pi-terminal-theme-${version}.tgz";
      hash = "sha512-nbTHJNvL0KheWX/zsoW+6+9Sh1YO6j98aIDQjfSXh0j8qAbMAtIMZeSC2FeboAk+81MAlcXEx6SMKS7x9cCDZg==";
    };

    sourceRoot = "package";
    dontBuild = true;

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R . $out/
      runHook postInstall
    '';
  };

  pimagotchi = pkgs.stdenv.mkDerivation rec {
    pname = "pimagotchi";
    version = "1.1.3";

    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@studiosunnyfield/pimagotchi/-/pimagotchi-${version}.tgz";
      hash = "sha512-Bbl8gY9sBkXABYtXr0DPdZtn0dP5Iz4rBFPHu7ym/xOwANG5IKdKZkvxK8NUuBZpegVQI8eAZFnBwDxxuPj3cA==";
    };

    sourceRoot = "package";
    dontBuild = true;

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R . $out/
      runHook postInstall
    '';
  };

  pi-tool-display = pkgs.stdenv.mkDerivation rec {
    pname = "pi-tool-display";
    version = "0.3.6";

    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/pi-tool-display/-/pi-tool-display-${version}.tgz";
      hash = "sha512-yW43rSj2Yah0hZIAYXEClAeBxPq3gwUW/kbGMy5RG9ri5ndo3EIBTL9zDEjxYT3y1mzpFVhLnW6CQVCMNwUOHA==";
    };

    sourceRoot = "package";
    dontBuild = true;

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R . $out/
      runHook postInstall
    '';
  };

  pi-claude-bridge = pkgs.buildNpmPackage rec {
    pname = "pi-claude-bridge";
    version = "0.3.1";

    src = pkgs.fetchFromGitHub {
      owner = "elidickinson";
      repo = "pi-claude-bridge";
      tag = "v${version}";
      hash = "sha256-6He/Le6PtjKQr+OLAHlDcH25VxgnCNWOJbVAd6YZbYI=";
    };

    postPatch = ''
      ${lib.getExe pkgs.jq} '
        .packages["node_modules/zod"].resolved = "https://registry.npmjs.org/zod/-/zod-4.3.6.tgz"
        | .packages["node_modules/zod"].integrity = "sha512-rftlrkhHZOcjDwkGlnUtZZkvaPHCsDATp4pGpuOOMDaTdDDXF91wuVDJoWoPsKX/3YPQ5fHuF3STjcYyKr+Qhg=="
      ' package-lock.json > package-lock.json.tmp
      mv package-lock.json.tmp package-lock.json
    '';

    npmDepsFetcherVersion = 2;
    npmDepsHash = "sha256-RRB6oWRmD0TCUf2Y53FF0WRkSZnHoHCl893GYHBiJj8=";
    dontNpmBuild = true;

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R . $out/
      runHook postInstall
    '';
  };

  pi-web-access = pkgs.buildNpmPackage {
    pname = "pi-web-access";
    version = "0.10.7";
    src = inputs.pi-web-access;

    npmDepsHash = "sha256-QKmgVmIvqLbqnUmKBKniT0CvNIgZWZ9mUkha0LJMMVQ=";
    dontNpmBuild = true;

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R . $out/
      runHook postInstall
    '';
  };

  rtk =
    let
      version = "0.38.0";
      asset =
        {
          x86_64-linux = {
            name = "rtk-x86_64-unknown-linux-musl.tar.gz";
            hash = "sha256-m6+zVkUPsPZqfy1o0EaNGx4nAWPxYgV05npMj4FtlhA=";
          };
          aarch64-linux = {
            name = "rtk-aarch64-unknown-linux-gnu.tar.gz";
            hash = "sha256-LhcfHRx2CGu0R+Ny2TMoadLNPMEGwIxuX70QKxLpGtk=";
          };
        }
        .${pkgs.stdenv.hostPlatform.system};
    in
    pkgs.stdenv.mkDerivation {
      pname = "rtk";
      inherit version;

      src = pkgs.fetchurl {
        url = "https://github.com/rtk-ai/rtk/releases/download/v${version}/${asset.name}";
        inherit (asset) hash;
      };

      sourceRoot = ".";
      dontBuild = true;

      installPhase = ''
        runHook preInstall
        install -Dm755 rtk $out/bin/rtk
        runHook postInstall
      '';
    };

  context-mode = pkgs.stdenv.mkDerivation {
    pname = "context-mode";
    version = "1.0.107";
    src = inputs.context-mode;

    nativeBuildInputs = [
      b2n.hook
      pkgs.bun
      pkgs.nodejs
    ];

    bunDeps = b2n.fetchBunDeps {
      bunNix = lock "context-mode-bun.nix";
    };

    dontUseBunBuild = true;
    dontUseBunCheck = true;
    dontUseBunInstall = true;

    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      bun run tsc
      bun -e "if (process.platform !== 'win32') require('fs').chmodSync('build/cli.js', 0o755)"
      bun run bundle
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R . $out/
      runHook postInstall
    '';
  };
}
