{ pkgs, ... }:

pkgs.stdenv.mkDerivation rec {
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
}
