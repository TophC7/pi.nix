{ pkgs, ... }:

pkgs.stdenv.mkDerivation rec {
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
}
