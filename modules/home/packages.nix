{
  lib,
  pkgs,
  inputs,
}:
let
  contextModeNodeModules = pkgs.stdenv.mkDerivation {
    pname = "context-mode-node-modules";
    version = "1.0.107";
    src = inputs.context-mode;

    nativeBuildInputs = [ pkgs.bun ];

    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      bun install --frozen-lockfile
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R node_modules $out/
      runHook postInstall
    '';

    outputHashMode = "recursive";
    outputHash = "sha256-sdhKDBlzPk4GpuCAsdaqx7aaLqPJQQYtirUTFq9077w=";
  };
in
{
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

  context-mode = pkgs.stdenv.mkDerivation {
    pname = "context-mode";
    version = "1.0.107";
    src = inputs.context-mode;

    nativeBuildInputs = [ pkgs.nodejs ];

    buildPhase = ''
      runHook preBuild
      cp -R ${contextModeNodeModules}/node_modules ./node_modules
      chmod -R u+w node_modules
      patchShebangs node_modules
      npm run build
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
