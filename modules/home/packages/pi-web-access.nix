{
  pkgs,
  inputs,
  b2n,
  lock,
  ...
}:

pkgs.stdenv.mkDerivation {
  pname = "pi-web-access";
  version = "0.10.7";
  src = inputs.pi-web-access;

  nativeBuildInputs = [
    b2n.hook
    pkgs.bun
  ];

  bunDeps = b2n.fetchBunDeps {
    bunNix = lock "pi-web-access-bun.nix";
  };

  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;

  bunInstallFlags = [
    "--linker=isolated"
    "--offline"
    "--production"
    "--omit=optional"
  ];

  postUnpack = ''
    cp ${lock "pi-web-access-bun.lock"} $sourceRoot/bun.lock
    chmod u+w $sourceRoot/bun.lock
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -R . $out/
    runHook postInstall
  '';
}
