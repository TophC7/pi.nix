{ pkgs, ... }:

pkgs.stdenv.mkDerivation {
  pname = "pi-desktop-notify";
  version = "0.1.0";

  src = ./.;

  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -R . $out/
    rm -f $out/default.nix
    substituteInPlace $out/extensions/linux-desktop-notify.ts \
      --replace-fail '@notifySend@' '${pkgs.libnotify}/bin/notify-send'
    runHook postInstall
  '';
}
