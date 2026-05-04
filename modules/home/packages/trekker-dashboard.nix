{
  pkgs,
  b2n,
  lock,
  ...
}:

pkgs.stdenv.mkDerivation rec {
  pname = "trekker-dashboard";
  version = "1.12.0";

  src = pkgs.fetchFromGitHub {
    owner = "obsfx";
    repo = "trekker-dashboard";
    rev = "554a868fa72bc346b034257bfe9c568572ebf72c";
    hash = "sha256-21DfNRs6EeaPZIobLS0mmqqCcHXckyBpmwHlOhQ0JfU=";
  };

  nativeBuildInputs = [
    b2n.hook
    pkgs.bun
    pkgs.makeWrapper
    pkgs.nodejs
  ];

  bunDeps = b2n.fetchBunDeps {
    bunNix = lock "trekker-dashboard-bun.nix";
  };

  dontUseBunCheck = true;
  dontUseBunInstall = true;

  postPatch = ''
    substituteInPlace bin/trekker-dashboard.js package.json README.md \
      --replace-fail ".trekker" ".sworm/trekker"
  '';

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    bun run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    app=$out/share/trekker-dashboard
    mkdir -p $app $out/bin
    cp -R bin dist node_modules package.json README.md $app/
    mv $app/bin/trekker-dashboard.js $app/bin/trekker-dashboard
    chmod +x $app/bin/trekker-dashboard
    makeWrapper $app/bin/trekker-dashboard $out/bin/trekker-dashboard \
      --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun ]}
    runHook postInstall
  '';
}
