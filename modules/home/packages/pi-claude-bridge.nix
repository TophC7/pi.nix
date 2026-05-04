{
  lib,
  pkgs,
  claudeCode,
  ...
}:

pkgs.buildNpmPackage rec {
  pname = "pi-claude-bridge";
  version = "0.3.1";

  src = pkgs.fetchFromGitHub {
    owner = "elidickinson";
    repo = "pi-claude-bridge";
    tag = "v${version}";
    hash = "sha256-6He/Le6PtjKQr+OLAHlDcH25VxgnCNWOJbVAd6YZbYI=";
  };

  postPatch = ''
    ${lib.getExe pkgs.jq} '
      .packages["node_modules/zod"].resolved = "https://registry.npmjs.org/zod/-/zod-4.3.6.tgz"
      | .packages["node_modules/zod"].integrity = "sha512-rftlrkhHZOcjDwkGlnUtZZkvaPHCsDATp4pGpuOOMDaTdDDXF91wuVDJoWoPsKX/3YPQ5fHuF3STjcYyKr+Qhg=="
    ' package-lock.json > package-lock.json.tmp
    mv package-lock.json.tmp package-lock.json

    sed -i '/^[[:space:]]*permissionMode: "bypassPermissions",$/i\    pathToClaudeCodeExecutable: "${lib.getExe claudeCode}",' index.ts
    count=$(grep -c 'pathToClaudeCodeExecutable: "${lib.getExe claudeCode}"' index.ts)
    test "$count" -eq 2
  '';

  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-RRB6oWRmD0TCUf2Y53FF0WRkSZnHoHCl893GYHBiJj8=";
  dontNpmBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -R . $out/
    runHook postInstall
  '';
}
