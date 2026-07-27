{
  pkgs,
  inputs,
  b2n,
  lock,
  ...
}:

pkgs.stdenv.mkDerivation {
  pname = "impeccable";
  version = "4.0.2";
  src = inputs.impeccable;

  nativeBuildInputs = [
    b2n.hook
    pkgs.bun
  ];

  bunDeps = b2n.fetchBunDeps {
    bunNix = lock "impeccable-bun.nix";
  };

  dontUseBunBuild = true;
  dontUseBunCheck = true;

  bunInstallFlags = [
    "--linker=isolated"
    "--offline"
    "--production"
    "--omit=optional"
  ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out
    cp -R .pi/. $out/
    cp -R node_modules $out/node_modules
    chmod -R u+w $out

    skill_dir="$out/skills/impeccable"
    package_skill_path="~/.pi/agent/packages/impeccable/skills/impeccable"

    while IFS= read -r file; do
      if grep -q '.pi/skills/impeccable' "$file"; then
        substituteInPlace "$file" \
          --replace-fail '.pi/skills/impeccable' "$package_skill_path" \
          --replace-quiet "node $package_skill_path" "bun $package_skill_path"
      fi
    done < <(find "$skill_dir" -type f -name '*.md')

    # Drop the whole allowed-tools block, however many entries upstream lists.
    # A fixed line count leaves orphaned list items behind in the frontmatter.
    sed -i '/^allowed-tools:$/,/^---$/{/^allowed-tools:$/d; /^ *- /d}' "$skill_dir/SKILL.md"

    while IFS= read -r file; do
      substituteInPlace "$file" \
        --replace-quiet 'npx impeccable detect' "bun $package_skill_path/scripts/detect.mjs" \
        --replace-quiet 'npx impeccable poll' "bun $package_skill_path/scripts/live-poll.mjs" \
        --replace-quiet 'npx impeccable wrap' "bun $package_skill_path/scripts/live-wrap.mjs" \
        --replace-quiet 'npx impeccable live' "bun $package_skill_path/scripts/live.mjs" \
        --replace-quiet 'npx impeccable update' 'update the pi.nix impeccable flake input'
    done < <(find "$skill_dir" -type f)

    substituteInPlace "$skill_dir/reference/hooks.md" \
      --replace-quiet 'Use `npx impeccable ignores ...` for direct CLI CRUD on the same detector ignores.' \
        'Use `/impeccable hooks ...` for direct CRUD on the same detector ignores.'

    substituteInPlace "$skill_dir/scripts/context.mjs" \
      --replace-fail 'async function computeUpdateDirective(now = Date.now()) {' \
        'async function computeUpdateDirective(now = Date.now()) {
  return null; // Nix-owned package updates through the pi.nix flake input.'

    runHook postInstall
  '';
}
