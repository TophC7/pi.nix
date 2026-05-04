{
  pkgs,
  inputs,
  b2n,
  lock,
  ...
}:

pkgs.stdenv.mkDerivation {
  pname = "context-mode";
  version = "1.0.107";
  src = inputs.context-mode;

  nativeBuildInputs = [
    b2n.hook
    pkgs.bun
    pkgs.nodejs
  ];

  bunDeps = b2n.fetchBunDeps {
    bunNix = lock "context-mode-bun.nix";
  };

  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    bun run tsc
    bun -e "if (process.platform !== 'win32') require('fs').chmodSync('build/cli.js', 0o755)"
    bun run bundle
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -R . $out/
    runHook postInstall
  '';
}
