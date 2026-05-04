# pi.nix

Home Manager module for Pi coding agent package, config, local extensions, RTK, and third-party Pi packages.

## Use

Add flake input:

```nix
{
  inputs.pi-nix.url = "git+file:///repo/Nix/pi.nix";
}
```

Import module in Home Manager:

```nix
{
  imports = [ inputs.pi-nix.homeManagerModules.default ];

  programs.pi = {
    enable = true;
    provider = "google-gemini-cli";
    model = "gemini-3.1-pro-preview";
  };
}
```

`programs.pi.package` defaults to `pi-nix`'s pinned `llm-agents` Pi package.

## NPM isolation

No global npm install. Heavy packages build inside Nix:

- `pi-claude-bridge`: `buildNpmPackage` from tagged source with upstream `package-lock.json`
- `pi-web-access`: `buildNpmPackage` with locked `package-lock.json`
- `context-mode`: `bun2nix` dependencies, then Bun-driven Nix build with no npm shellout

Pi loads resulting store paths through `settings.json` `packages`, so dependencies stay package-local. The module also installs `rtk` for `pi-rtk-optimizer` command rewrites.
