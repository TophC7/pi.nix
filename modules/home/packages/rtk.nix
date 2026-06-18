{ pkgs, ... }:

let
  version = "0.42.4";
  asset =
    {
      x86_64-linux = {
        name = "rtk-x86_64-unknown-linux-musl.tar.gz";
        hash = "sha256-NJdRFtoR4J5QJQHa91gUPgsi7TpCoQ62f7aTpicNnjY=";
      };
      aarch64-linux = {
        name = "rtk-aarch64-unknown-linux-gnu.tar.gz";
        hash = "sha256-zCuRwGTrZwwJfBhJE8j7yxqUPVPX/lBTdelroMW2RZ8=";
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
