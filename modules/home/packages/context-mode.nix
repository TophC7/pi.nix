{
  lib,
  pkgs,
  inputs,
  b2n,
  lock,
  ...
}:

pkgs.stdenv.mkDerivation {
  pname = "context-mode";
  version = (lib.importJSON (inputs.context-mode + "/package.json")).version;
  src = inputs.context-mode;

  nativeBuildInputs = [
    b2n.hook
    pkgs.bun
  ];

  bunDeps = b2n.fetchBunDeps {
    bunNix = lock "context-mode-bun.nix";
  };

  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;

  bunInstallFlags = [
    "--linker=isolated"
    "--offline"
  ];

  postPatch = ''
    # package.json lists better-sqlite3 as a dependency, while bun.lock pins it
    # as optional. Keep package.json aligned with bun.lock so
    # Bun does not try to re-resolve the package manifest inside the Nix sandbox.
    bun -e '
      const fs = require("fs");
      const packageJsonPath = "package.json";
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      const betterSqliteVersion = packageJson.dependencies?.["better-sqlite3"];

      if (betterSqliteVersion) {
        packageJson.optionalDependencies = packageJson.optionalDependencies ?? {};
        packageJson.optionalDependencies["better-sqlite3"] = betterSqliteVersion;
        delete packageJson.dependencies["better-sqlite3"];
        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
      }
    '
  '';

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
