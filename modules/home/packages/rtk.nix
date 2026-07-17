{ pkgs, ... }:

let
  version = "0.43.0";
  asset =
    {
      x86_64-linux = {
        name = "rtk-x86_64-unknown-linux-musl.tar.gz";
        hash = "sha256-/4oed2ZJbhdSkaha7KHcl8n/bfM+UeWJPR+8eP6ipgk=";
      };
      aarch64-linux = {
        name = "rtk-aarch64-unknown-linux-gnu.tar.gz";
        hash = "sha256-VRn3yhLlwUOmCfDSigp3uXQTqNzjHCaB8aQcJFGahzE=";
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
}
