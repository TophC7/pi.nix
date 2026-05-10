{ lib, config, pkgs, ... }:
let
  cfg = config.programs.pi;
  inherit (lib) mkOption types;

  packageModule = types.submodule ({ name, ... }: {
    options = {
      source = mkOption {
        type = types.path;
        description = "Source file or directory for the local Pi package `${name}`.";
      };

      entry = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = ''
          Extension entry path relative to `source` for directory-shaped packages.
          Leave null to register the directory itself. Ignored for support-only packages.
        '';
      };

      agentsDir = mkOption {
        type = types.nullOr types.str;
        default = "agents";
        description = "Optional directory of package-owned agent markdown files, relative to `source`.";
      };

      supportOnly = mkOption {
        type = types.bool;
        default = false;
        description = "Link source into the runtime tree without registering it as a Pi extension.";
      };
    };
  });

  externalPackageModule = types.submodule ({ ... }: {
    options = {
      name = mkOption {
        type = types.str;
        description = "Stable package name exposed under ~/.pi/agent/packages/<name>.";
      };

      package = mkOption {
        type = types.oneOf [ types.path types.package types.str ];
        description = "Package source path or derivation to expose to Pi.";
      };
    };
  });

  sourceType = source: builtins.readFileType source;
  isDirectory = source: sourceType source == "directory";

  packageRecords = lib.mapAttrsToList (name: package:
    let
      directory = isDirectory package.source;
      bundleName = if directory then name else baseNameOf (toString package.source);
    in
    {
      inherit name package directory bundleName;
      linkName = bundleName;
    }
  ) cfg.packages;

  hasPiLib = cfg.packages ? pi-lib;

  copyPackage = record:
    if record.directory then ''
      mkdir -p "$out/${record.bundleName}"
      cp -R ${record.package.source}/. "$out/${record.bundleName}/"
      chmod -R u+w "$out/${record.bundleName}"
    '' else ''
      cp ${record.package.source} "$out/${record.bundleName}"
    '';

  linkPiLibForPackage = record: lib.optionalString (hasPiLib && record.directory && record.name != "pi-lib") ''
    mkdir -p "$out/${record.bundleName}/node_modules/@pi"
    ln -s ../../../pi-lib "$out/${record.bundleName}/node_modules/@pi/lib"
  '';

  extensionBundle = pkgs.runCommand "pi-local-extensions" { } ''
    mkdir -p "$out"
    ${lib.concatMapStringsSep "\n" copyPackage packageRecords}
    ${lib.concatMapStringsSep "\n" linkPiLibForPackage packageRecords}
  '';

  extensionLink = record: {
    name = ".pi/agent/extensions/${record.linkName}";
    value.source = "${extensionBundle}/${record.bundleName}";
  };

  extensionLinks = builtins.listToAttrs (map extensionLink packageRecords);

  packageAgentFiles = record:
    let
      agentsDir = record.package.agentsDir;
      agentsPath = record.package.source + "/${agentsDir}";
    in
    if record.directory && agentsDir != null && builtins.pathExists agentsPath then
      builtins.filter (file: lib.hasSuffix ".md" file) (builtins.attrNames (builtins.readDir agentsPath))
    else
      [ ];

  packageAgentEntries = record:
    builtins.listToAttrs (map (file: {
      name = ".pi/agent/agents/${record.name}/${file}";
      value.source = "${extensionBundle}/${record.bundleName}/${record.package.agentsDir}/${file}";
    }) (packageAgentFiles record));

  agentLinks = lib.foldl' (acc: record: acc // packageAgentEntries record) { } packageRecords;

  topLevelPiLibResolverLink = lib.optionalAttrs hasPiLib {
    ".pi/agent/extensions/node_modules/@pi/lib".source = "${extensionBundle}/pi-lib";
  };

  externalPackageLink = entry: {
    name = ".pi/agent/packages/${entry.name}";
    value.source = entry.package;
  };

  externalPackageLinks = builtins.listToAttrs (map externalPackageLink cfg.externalPackages);

  extensionPath = record:
    if record.package.supportOnly then
      null
    else if record.directory && record.package.entry != null then
      "~/.pi/agent/extensions/${record.name}/${record.package.entry}"
    else
      "~/.pi/agent/extensions/${record.linkName}";

  extensionPaths = builtins.filter (value: value != null) (map extensionPath packageRecords);

  packageEntries = map (entry: "~/.pi/agent/packages/${entry.name}") cfg.externalPackages;

  generatedHomeFiles = extensionLinks // agentLinks // topLevelPiLibResolverLink // externalPackageLinks;
in
{
  options.programs.pi = {
    packages = mkOption {
      type = types.attrsOf packageModule;
      default = { };
      description = ''
        Declarative local Pi package/source registry. Directory packages are linked
        under ~/.pi/agent/extensions/<name>; single-file packages preserve their
        source basename. `supportOnly = true` links runtime support code without
        adding an extension entry to settings.json.
      '';
    };

    externalPackages = mkOption {
      type = types.listOf externalPackageModule;
      default = [ ];
      description = ''
        External Pi packages exposed under ~/.pi/agent/packages/<name> and listed
        in settings.json by that stable local path.
      '';
    };

    extensionSystem = {
      bundle = mkOption {
        type = types.package;
        readOnly = true;
        description = "Generated local extension bundle with resolver symlinks.";
      };

      homeFiles = mkOption {
        type = types.attrs;
        readOnly = true;
        description = "Home Manager file entries for local extensions, package agents, resolver symlinks, and external packages.";
      };

      extensionPaths = mkOption {
        type = types.listOf types.str;
        readOnly = true;
        description = "settings.json extensions generated from programs.pi.packages.";
      };

      packageEntries = mkOption {
        type = types.listOf types.str;
        readOnly = true;
        description = "settings.json packages generated from programs.pi.externalPackages.";
      };
    };
  };

  config.programs.pi.extensionSystem = {
    bundle = extensionBundle;
    homeFiles = generatedHomeFiles;
    inherit extensionPaths packageEntries;
  };
}
