{
  lib,
  pkgs,
  inputs,
  ...
}:
let
  system = pkgs.stdenv.hostPlatform.system;
  pi = inputs.llm-agents.packages.${system}.pi;
  claudeCode = inputs.llm-agents.packages.${system}.claude-code;
in
pi.overrideAttrs (old: {
  nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [
    pkgs.makeWrapper
    pkgs.patch
  ];

  # Apply source patches before llm-agents compiles Pi's standalone Bun binary.
  preInstall = ''
    patch -p1 < ${../patches/pi-ai-discard-failed-tool-continuations.patch}
    patch -p1 < ${../patches/pi-tui-incremental-input-render.patch}
  ''
  + (old.preInstall or "");

  postInstall = (old.postInstall or "") + ''
    wrapProgram $out/bin/pi \
      --prefix PATH : ${
        lib.makeBinPath [
          pkgs.bun
          pkgs.fd
          pkgs.ripgrep
          claudeCode
        ]
      } \
      --set IMPECCABLE_NO_UPDATE_CHECK 1
  '';
})
