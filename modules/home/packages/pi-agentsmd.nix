{ pkgs, inputs, ... }:

pkgs.stdenvNoCC.mkDerivation {
  pname = "pi-agentsmd";
  version = "0.1.1";
  src = inputs.pi-agentsmd + "/packages/pi-agentsmd";

  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -R . $out/
    runHook postInstall
  '';
}
