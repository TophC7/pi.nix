{
  pkgs,
  inputs,
  ...
}:

pkgs.buildNpmPackage {
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
}
