#!/usr/bin/env fish

set -l mode update
if test (count $argv) -gt 1
    echo 'Usage: nix run .#update [-- --check|--resume]' >&2
    exit 2
else if test (count $argv) -eq 1
    switch $argv[1]
        case --check
            set mode check
        case --resume
            set mode resume
        case '*'
            echo 'Usage: nix run .#update [-- --check|--resume]' >&2
            exit 2
    end
end

set -l root (pwd -P)
if not test -f "$root/flake.nix" -a -d "$root/locks" -a -f "$root/modules/home/packages/rtk/version.json"
    echo 'Run from the pi.nix repository root.' >&2
    exit 1
end

if test "$mode" = update
    set -l dirty (git status --porcelain -- flake.lock locks modules/home/packages/rtk/version.json)
    if test (count $dirty) -gt 0
        echo 'Commit, restore, or resume existing generated-state changes:' >&2
        printf '%s\n' $dirty >&2
        echo 'Resume with: nix run .#update -- --resume' >&2
        exit 1
    end

    nix flake update
    or exit 1

    # Re-evaluate the app so lock generation sees the newly pinned inputs.
    exec nix run "path:$root#update" -- --resume
end

for name in PI_BUN PI_BUN2NIX PI_SOURCE_CONTEXT_MODE PI_SOURCE_IMPECCABLE PI_SOURCE_MCP_ADAPTER PI_SOURCE_WEB_ACCESS PI_SYSTEM
    if not set -q $name
        echo "Missing $name. Run through nix run .#update." >&2
        exit 1
    end
end

set -l tmp (mktemp -d)
set -l generated "$tmp/generated"
mkdir -p "$generated"

function cleanup --on-event fish_exit --inherit-variable tmp
    rm -rf "$tmp"
end

function update_rtk --argument-names versionFile outputFile
    set -l releaseFile "$outputFile.release"
    curl -fsSL https://api.github.com/repos/rtk-ai/rtk/releases/latest >$releaseFile
    or return 1

    set -l tag (jq -r '.tag_name // empty' <$releaseFile)
    set -l latestVersion (string replace -r '^v' '' "$tag")
    set -l currentVersion (jq -r .version <$versionFile)
    if test -z "$latestVersion"
        echo 'Could not determine latest RTK release.' >&2
        return 1
    else if test "$latestVersion" = "$currentVersion"
        echo "RTK is current ($currentVersion)."
        return 0
    end

    echo "Updating RTK $currentVersion -> $latestVersion..."
    set -l x86Name rtk-x86_64-unknown-linux-musl.tar.gz
    set -l baseUrl "https://github.com/rtk-ai/rtk/releases/download/$tag"

    nix store prefetch-file --json "$baseUrl/$x86Name" >"$outputFile.x86"
    or return 1

    set -l x86Hash (jq -r .hash <"$outputFile.x86")
    jq -n \
        --arg version "$latestVersion" \
        --arg x86Name "$x86Name" \
        --arg x86Hash "$x86Hash" \
        '{version: $version, assets: {"x86_64-linux": {name: $x86Name, hash: $x86Hash}}}' \
        >$outputFile
    or return 1

    mv "$outputFile" "$versionFile"
end

function copy_source --argument-names source destination
    mkdir -p "$destination"
    cp -R "$source/." "$destination"
    chmod -R u+w "$destination"
end

function generate_upstream_lock --argument-names name source --inherit-variable generated
    if not test -f "$source/bun.lock"
        echo "$name source has no bun.lock" >&2
        return 1
    end
    "$PI_BUN2NIX" --lock-file "$source/bun.lock" --output-file "$generated/$name-bun.nix"
end

function generate_local_lock --argument-names name source --inherit-variable tmp --inherit-variable generated
    set -l work "$tmp/$name"
    copy_source "$source" "$work"
    rm -f "$work/bun.lock" "$work/package-lock.json"
    begin
        cd "$work"
        "$PI_BUN" install --lockfile-only --ignore-scripts
    end
    or return 1
    cp "$work/bun.lock" "$generated/$name-bun.lock"
    "$PI_BUN2NIX" --lock-file "$work/bun.lock" --output-file "$generated/$name-bun.nix"
end

# Without an upstream lock, the committed Bun lock is the dependency pin.
function verify_local_lock --argument-names name source --inherit-variable root --inherit-variable tmp --inherit-variable generated
    set -l work "$tmp/$name"
    set -l lock "$root/locks/$name-bun.lock"
    copy_source "$source" "$work"
    cp "$lock" "$work/bun.lock"
    rm -f "$work/package-lock.json"
    begin
        cd "$work"
        "$PI_BUN" install --lockfile-only --ignore-scripts --frozen-lockfile
    end
    or return 1
    cp "$work/bun.lock" "$generated/$name-bun.lock"
    "$PI_BUN2NIX" --lock-file "$work/bun.lock" --output-file "$generated/$name-bun.nix"
end

function validate --argument-names root --inherit-variable tmp
    echo 'Evaluating x86_64-linux...'
    nix flake check "path:$root" --no-build
    or return 1

    set -l packageNamesFile "$tmp/package-names.json"
    nix eval --json "path:$root#packages.$PI_SYSTEM" --apply builtins.attrNames >$packageNamesFile
    or return 1

    set -l targets
    for name in (jq -r '.[] | select(. != "default")' <$packageNamesFile)
        set -a targets "path:$root#$name"
    end

    echo "Building all $PI_SYSTEM packages..."
    nix build --no-link $targets
end

if test "$mode" = resume
    update_rtk "$root/modules/home/packages/rtk/version.json" "$tmp/rtk-version.json"
    or exit 1
end

generate_upstream_lock context-mode "$PI_SOURCE_CONTEXT_MODE"; or exit 1
generate_upstream_lock impeccable "$PI_SOURCE_IMPECCABLE"; or exit 1
if test "$mode" = check
    verify_local_lock pi-mcp-adapter "$PI_SOURCE_MCP_ADAPTER"; or exit 1
    verify_local_lock pi-web-access "$PI_SOURCE_WEB_ACCESS"; or exit 1
else
    generate_local_lock pi-mcp-adapter "$PI_SOURCE_MCP_ADAPTER"; or exit 1
    generate_local_lock pi-web-access "$PI_SOURCE_WEB_ACCESS"; or exit 1
end

set -l artifacts \
    context-mode-bun.nix \
    impeccable-bun.nix \
    pi-mcp-adapter-bun.lock \
    pi-mcp-adapter-bun.nix \
    pi-web-access-bun.lock \
    pi-web-access-bun.nix

if test "$mode" = check
    set -l stale 0
    for artifact in $artifacts
        if not diff -u "$root/locks/$artifact" "$generated/$artifact"
            set stale 1
        end
    end
    if test $stale -ne 0
        echo 'Generated locks are stale. Run nix run .#update.' >&2
        exit 1
    end
else
    for artifact in $artifacts
        cp "$generated/$artifact" "$root/locks/$artifact"
    end
end

validate "$root"
or exit 1

if test "$mode" = check
    echo 'Generated state and package builds are current.'
else
    echo 'Repository update complete. Review git diff.'
end
