# pi.nix

Home Manager module for Pi coding agent package, config, local extensions, and third-party Pi packages.

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

- `pi-web-access`: `buildNpmPackage` with locked `package-lock.json`
- `context-mode`: Bun lock fetch in fixed-output derivation, then Nix build

Pi loads resulting store paths through `settings.json` `packages`, so dependencies stay package-local.
