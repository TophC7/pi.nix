{
  lib,
  pkgs,
  inputs,
  ...
}:
let
  system = pkgs.stdenv.hostPlatform.system;
  pi = inputs.pi-source.packages.${system}.pi;
  claudeCode = inputs.llm-agents.packages.${system}.claude-code;
in
pi.overrideAttrs (old: {
  nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.makeWrapper ];

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
