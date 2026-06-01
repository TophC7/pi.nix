{
  pkgs,
  inputs,
  ...
}:

# pi-claude-bridge uses Claude Code (via the Agent SDK) as a Pi model provider.
# v0.4.0 loads ./src/index.ts directly and reads the Claude executable path from
# ~/.pi/agent/claude-bridge.json, so no source patching is needed: the home
# module writes that config (see claude-bridge.json), and zod is already pinned
# correctly upstream.
pkgs.buildNpmPackage {
  pname = "pi-claude-bridge";
  version = "0.4.0";
  src = inputs.pi-claude-bridge;

  npmDepsHash = "sha256-lITn+l+Of5SQK1+ycNK9fES0bKCvJoKAq/6Nf8tgMY0=";
  dontNpmBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -R . $out/
    runHook postInstall
  '';
}
