{ lib, pkgs, ... }:

let
  release = lib.importJSON ./version.json;
  system = pkgs.stdenv.hostPlatform.system;
  asset = release.assets.${system} or (throw "pi.nix does not support RTK on ${system}");
in
pkgs.stdenv.mkDerivation {
  pname = "rtk";
  inherit (release) version;

  src = pkgs.fetchurl {
    url = "https://github.com/rtk-ai/rtk/releases/download/v${release.version}/${asset.name}";
    inherit (asset) hash;
  };

  sourceRoot = ".";
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    install -Dm755 rtk $out/bin/rtk
    runHook postInstall
  '';
}
