{
  pkgs,
  inputs,
  b2n,
  lock,
  ...
}:

# pi-claude-bridge uses Claude Code (via the Agent SDK) as a Pi model provider.
# v0.6.2 loads ./src/index.ts directly and reads the Claude executable path from
# ~/.pi/agent/claude-bridge.json, so no source patching is needed: the home
# module writes that config (see claude-bridge.json).
pkgs.stdenv.mkDerivation {
  pname = "pi-claude-bridge";
  version = "0.6.2";
  src = inputs.pi-claude-bridge;

  nativeBuildInputs = [
    b2n.hook
    pkgs.bun
  ];

  bunDeps = b2n.fetchBunDeps {
    bunNix = lock "pi-claude-bridge-bun.nix";
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
    cp ${lock "pi-claude-bridge-bun.lock"} $sourceRoot/bun.lock
    chmod u+w $sourceRoot/bun.lock
    rm -f $sourceRoot/package-lock.json
  '';

  postPatch = ''
    # Upstream imports zod from src/typebox-to-zod.ts but does not declare it.
    # Keep package.json aligned with the vendored bun.lock generated for this
    # Nix package.
    bun -e '
      const fs = require("fs");
      const packageJsonPath = "package.json";
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      packageJson.dependencies = packageJson.dependencies ?? {};
      packageJson.dependencies.zod = "^4.0.0";
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
    '
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -R . $out/
    runHook postInstall
  '';
}
