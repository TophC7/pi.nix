{
  pkgs,
  inputs,
  b2n,
  lock,
  ...
}:

# pi-mcp-adapter bridges MCP servers into Pi as first-class tools via
# pi.registerTool(). It is the only thing standing between us and a working
# `~/.pi/agent/mcp.json` — Pi itself has no native MCP loader.
#
# Build shape mirrors context-mode.nix: fetch bun deps via b2n, materialise
# node_modules, copy source as-is. The package has no compile step; Pi loads
# index.ts directly through bun at runtime.
#
# Upstream does not commit bun.lock, so we ship our own at
# locks/pi-mcp-adapter-bun.lock and drop it in during unpack. The lock and
# the bun2nix nix expression are generated together and must stay paired.
pkgs.stdenv.mkDerivation {
  pname = "pi-mcp-adapter";
  version = "2.6.0";
  src = inputs.pi-mcp-adapter;

  nativeBuildInputs = [
    b2n.hook
    pkgs.bun
    pkgs.nodejs
  ];

  bunDeps = b2n.fetchBunDeps {
    bunNix = lock "pi-mcp-adapter-bun.nix";
  };

  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;

  patches = [ ../patches/pi-mcp-adapter-slab-status.patch ];

  postPatch = ''
    substituteInPlace init.ts \
      --replace-fail '  if (total === 0) {' '  if (total === 0) {
    clearSlabStatus();' \
      --replace-fail '  const connectedCount = state.manager.getAllConnections().size;' '  const snapshot = writeSlabStatus(state);' \
      --replace-fail '  ui.setStatus("mcp", ui.theme.fg("accent", `MCP: ''${connectedCount}/''${total} servers`));' '  const tools = snapshot.totalTools > 0 ? ` (''${snapshot.totalTools} tools)` : "";
  ui.setStatus("mcp", ui.theme.fg("accent", `MCP: ''${snapshot.connected}/''${total} servers''${tools}`));'
  '';

  postUnpack = ''
    cp ${lock "pi-mcp-adapter-bun.lock"} $sourceRoot/bun.lock
    chmod u+w $sourceRoot/bun.lock
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -R . $out/
    runHook postInstall
  '';
}
