{
  pkgs,
  b2n,
  lock,
  ...
}:

pkgs.stdenv.mkDerivation rec {
  pname = "trekker";
  version = "1.11.0";

  src = pkgs.fetchFromGitHub {
    owner = "obsfx";
    repo = "trekker";
    rev = "3f2ac990f1d7ab1f2f18d660b1f5a6e9efa17180";
    hash = "sha256-5ZaMxJZ4bQI2jwZRMuZsCx1NDiPhNcRob3Xl/q46g5g=";
  };

  nativeBuildInputs = [
    b2n.hook
    pkgs.bun
    pkgs.makeWrapper
    pkgs.nodejs
  ];

  bunDeps = b2n.fetchBunDeps {
    bunNix = lock "trekker-bun.nix";
  };

  dontUseBunCheck = true;
  dontUseBunInstall = true;

  postPatch = ''
    substituteInPlace src/db/client.ts \
      --replace-fail "const TREKKER_DIR = '.trekker';" "const TREKKER_DIR = '.sworm/trekker';"
    substituteInPlace src/commands/quickstart.ts README.md \
      --replace-warn ".trekker/trekker.db" ".sworm/trekker/trekker.db" \
      --replace-warn ".trekker" ".sworm/trekker"
  '';

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    bun run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    app=$out/share/trekker
    mkdir -p $app $out/bin
    cp -R bin dist node_modules package.json README.md $app/
    mv $app/bin/trekker.js $app/bin/trekker
    chmod +x $app/bin/trekker
    makeWrapper $app/bin/trekker $out/bin/trekker \
      --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun ]}
    runHook postInstall
  '';
}
