{ pkgs, ... }:

pkgs.stdenv.mkDerivation rec {
  pname = "pi-token-burden";
  version = "0.6.3";

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/pi-token-burden/-/pi-token-burden-${version}.tgz";
    hash = "sha512-/2OVnLGernf7P/9mb3kwii7Uwoa1VobiyyQYC14Tl5EuGWNK3ErhlQsXs937W53Xq7F6exNP1Uf4fmigdhnRkA==";
  };

  gptTokenizer = pkgs.fetchurl {
    url = "https://registry.npmjs.org/gpt-tokenizer/-/gpt-tokenizer-3.4.0.tgz";
    hash = "sha512-wxFLnhIXTDjYebd9A9pGl3e31ZpSypbpIJSOswbgop5jLte/AsZVDvjlbEuVFlsqZixVKqbcoNmRlFDf6pz/UQ==";
  };

  sourceRoot = "package";
  dontBuild = true;

  # Upstream has no engines field. Published with Node 25.2.1; runtime relies
  # on Pi's TS/Jiti loader plus bundled peer aliases for @mariozechner/pi-*.
  installPhase = ''
    runHook preInstall

    mkdir -p $out
    cp -R . $out/

    mkdir -p $TMPDIR/gpt-tokenizer $out/node_modules/gpt-tokenizer
    tar -xzf $gptTokenizer -C $TMPDIR/gpt-tokenizer
    cp -R $TMPDIR/gpt-tokenizer/package/. $out/node_modules/gpt-tokenizer/

    runHook postInstall
  '';

  meta = {
    description = "Pi extension that shows a token-budget breakdown of the assembled system prompt";
    homepage = "https://www.npmjs.com/package/pi-token-burden";
    license = pkgs.lib.licenses.mit;
  };
}
