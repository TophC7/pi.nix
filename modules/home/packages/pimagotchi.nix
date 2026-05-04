{ pkgs, ... }:

pkgs.stdenv.mkDerivation rec {
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
}
