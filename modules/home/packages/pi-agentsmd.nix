{ lib, pkgs, inputs, ... }:

pkgs.stdenvNoCC.mkDerivation {
  pname = "pi-agentsmd";
  version = (lib.importJSON (inputs.pi-agentsmd + "/packages/pi-agentsmd/package.json")).version;
  src = inputs.pi-agentsmd + "/packages/pi-agentsmd";

  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -R . $out/
    runHook postInstall
  '';
}
