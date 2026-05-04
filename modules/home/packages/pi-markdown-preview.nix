{ pkgs, ... }:

pkgs.buildNpmPackage rec {
  pname = "pi-markdown-preview";
  version = "0.9.7";

  src = pkgs.fetchFromGitHub {
    owner = "omaclaren";
    repo = "pi-markdown-preview";
    tag = "v${version}";
    hash = "sha256-ilBbM48PXikmwFKhmjj8bAN6l+TPMUGOqPcPR5EgoCM=";
  };

  npmDepsHash = "sha256-d73c5MIBK1psnTVVF5WJRfzXNGP7QGlbIkjMj5n6ESE=";
  dontNpmBuild = true;
  npmFlags = [ "--legacy-peer-deps" ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -R . $out/
    runHook postInstall
  '';
}
