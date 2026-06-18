# pi.nix

A Nix-owned Pi distribution: package, runtime, prompt, tools, UI, workflow system, and all the little opinions that make Pi feel like Toph's Pi.

This repo started as a Home Manager module. It has grown into a full agent workbench. Nix pins the upstream Pi build, wraps it with Bun, installs local extensions, bridges MCP servers into Pi tools, owns the global agent prompt, and keeps the whole setup reproducible without global npm installs.

## What this provides

- **A patched Pi runtime** built from the pinned `llm-agents` input and wrapped to run under Bun.
- **Home Manager integration** through `inputs.pi-nix.homeManagerModules.default`.
- **Local Pi extensions** for review, cleanup, spec-driven development, QA, Buddy, Slab UI, Sworm issues, shell policy, and more.
- **External Pi packages** pinned and installed through Nix: ask-user, RTK optimizer, tool display, Claude bridge, web access, MCP adapter, context-mode.
- **MCP tools as first-class Pi tools** through `pi-mcp-adapter`, with context-mode and Playwright configured by default.
- **Global agent identity** through `modules/home/SOUL.md`, installed as `~/.pi/agent/AGENTS.md`.
- **Custom terminal UI** through Slab and `modules/home/themes/terminal.json`.
- **Nix-owned runtime config** under `~/.pi/agent/`: settings, theme, MCP registry, RTK optimizer config, extension links, and package links.

## Use

Add the flake input:

```nix
{
  inputs.pi-nix.url = "ssh://git@git.ryot.foo:222/toph/pi.nix.git";
}
```

Import the Home Manager module:

```nix
{
  imports = [ inputs.pi-nix.homeManagerModules.default ];

  programs.pi = {
    enable = true;
    provider = "openai-codex";
    model = "gpt-5.5";
  };
}
```

Available options are intentionally small:

| Option | Default | Purpose |
| --- | --- | --- |
| `programs.pi.enable` | `false` | Install and configure Pi. |
| `programs.pi.package` | repo-patched Pi | Override Pi package if needed. |
| `programs.pi.provider` | `openai-codex` | Default provider written to Pi settings. |
| `programs.pi.model` | `gpt-5.5` | Default model written to Pi settings. |

## How it works

```text
flake.nix
  → modules/home/default.nix
    → patched Bun-wrapped Pi package
    → modules/home/lib/pi-extension-system.nix
      → ~/.pi/agent/extensions/*
      → ~/.pi/agent/packages/*
      → ~/.pi/agent/settings.json
    → ~/.pi/agent/AGENTS.md
    → ~/.pi/agent/mcp.json
    → ~/.pi/agent/extensions/pi-rtk-optimizer/config.json
```

`modules/home/default.nix` owns main shape:

- wraps upstream Pi with `${pkgs.bun}/bin/bun`;
- disables version checks and telemetry;
- puts Bun, `fd`, and `ripgrep` on Pi's runtime `PATH`;
- applies local upstream patches from `modules/home/patches/`;
- installs support packages like RTK, `libnotify`, and `pandoc`;
- writes Pi settings with `defaultThinkingLevel = "high"`, `theme = "terminal"`, and `quietStartup = true`.

`modules/home/lib/pi-extension-system.nix` turns declarative package declarations into Pi runtime files:

- local extensions land under `~/.pi/agent/extensions`;
- external packages land under `~/.pi/agent/packages`;
- `settings.json.extensions` and `settings.json.packages` are generated from those declarations;
- directory extensions point at their `index.ts` entrypoint;
- support-only packages, especially `pi-lib`, can be linked without being registered as user-facing extensions.

## Local extensions

| Extension | What it adds |
| --- | --- |
| `commands` | `/commit`, `/pr`, `/config`; git-context-aware commit and PR workflows with model/thinking overrides. |
| `slab` | Custom footer/input surface, status segments, widgets, command shimmer, MCP status, config pane. |
| `buddy` | Terminal companion with commands, widgets, persistent DB state, memories, XP, reasoning guard mode, `buddy_remember`, `buddy_observe`. |
| `burden` | `/burden`, a token attribution explorer for prompt/tool/skill/context cost. |
| `sdd` | `/spec*` workflow: draft specs, check them, ship to Sworm, work tasks, visualize, close, freehand escape hatch. |
| `agentic-qa` | `/qa`, `/qa:staged`, `/qa:freehand`, and strict `qa_report` evidence reporting. |
| `cleanup` | `/cleanup`, `/cleanup:quick`; read-only scouts find obvious cleanup opportunities before apply. |
| `review` | `/review`, `/review:freehand`; adversarial scout swarm over staged diffs or scoped prompts. |
| `subagents` | Model-facing `subagent` tool with sequential, parallel, and chained child-agent runs. |
| `caveman` | `/caveman`; terse response style levels: off, lite, full, ultra, micro. |
| `clear` | `/clear`; reset current conversation. |
| `desktop-notify` | Desktop notifications for input requests, completion, follow-ups, and errors. |
| `sworm-issues` | Sworm epics/issues/comments/dependencies/config tools plus `/ready`, `/issues`, `/claim`. |
| `use-fish` | Replaces shell backend with Fish and injects shell-policy guidance. |
| `pi-lib` | Shared support library for commands, locks, RTK helpers, UI, subagents, status store. |

## Workflow personality

### Soul

`modules/home/SOUL.md` is the human part. It tells Pi to act as a creative partner, choose on merit, protect readability, prefer Nix/Bun/Fish, avoid Python by default, ask when intent is ambiguous, and keep code feeling like one mind wrote it.

Home Manager installs it as `~/.pi/agent/AGENTS.md`, so every Pi session starts with that stance.

### Review and cleanup

`review` and `cleanup` share a pattern:

1. collect local context;
2. launch read-only scout subagents;
3. synthesize findings;
4. start a guarded follow-up turn for triage or application.

Review is adversarial and broad: architecture, reuse, quality, idiom, comments, efficiency. Cleanup is narrower: remove slop, dead code, duplication, and easy waste without redesigning the world.

### Spec-driven development

`modules/home/extensions/sdd/` gives Pi a durable project loop:

- `/spec` creates or edits Markdown specs under `.sworm/sdd/`;
- `/spec:check` verifies shape and acceptance gates with scout subagents;
- `/spec:ship` turns spec tasks into Sworm epics/issues/dependencies;
- `/spec:work` claims ready Sworm issues, implements, verifies, comments, and loops;
- `/spec:visual` renders spec state;
- `/spec:freehand` deliberately exits the draft guardrails.

Specs hold intent. Sworm holds task state. Operation locks keep draft/check/ship/work phases from bleeding into unrelated file edits.

### Agentic QA

`agentic-qa` is evidence-first QA for localhost targets. It uses `.qa.md` mission files, Playwright/browser evidence, and strict final reports where pass/fail/bug claims need evidence IDs. Unsupported claims are downgraded to inconclusive.

Safety stance: synthetic data, no PHI, no credential handling, localhost by default.

### Buddy

Buddy is not only decoration. It is a small persistent companion system:

- species/personality/reaction model;
- XP and progress;
- local memories through `buddy_remember`;
- observed reasoning claims/edges through `buddy_observe`;
- guard-mode reasoning graph and retention;
- Slab widgets and dialogs.

It gives the session a tiny creature in the terminal, but the implementation is real state, schema, tools, and UI.

## MCP and external tooling

Pi does not natively load MCP servers here. `pi-mcp-adapter` reads `~/.pi/agent/mcp.json` and registers exposed MCP tools with Pi as normal model-callable tools.

Default MCP servers:

| Server | Lifecycle | Purpose |
| --- | --- | --- |
| `context-mode` | keep-alive | Context-saving command execution, file processing, indexing, search. |
| `playwright` | lazy | Browser automation through isolated Chromium. |

External packages are pinned through Nix:

| Package file | Package |
| --- | --- |
| `modules/home/packages/context-mode.nix` | `context-mode` 1.0.161 |
| `modules/home/packages/impeccable.nix` | Impeccable skill 3.7.1 |
| `modules/home/packages/pi-agentsmd.nix` | `pi-agentsmd` 0.1.1 |
| `modules/home/packages/pi-mcp-adapter.nix` | `pi-mcp-adapter` 2.8.0 |
| `modules/home/packages/pi-web-access.nix` | `pi-web-access` 0.10.7 |
| `modules/home/packages/pi-claude-bridge.nix` | `pi-claude-bridge` 0.4.0 |
| `modules/home/packages/playwright-mcp.nix` | nixpkgs `playwright-mcp` with Nix-provided browser bits |
| `modules/home/packages/rtk.nix` | RTK 0.42.0 |

Version is owned by the flake inputs. `pi-ask-user`, `pi-rtk-optimizer`, and `pi-tool-display` have no runtime deps and load `./index.ts` directly, so they are consumed as raw source inputs with no package file; `nix flake update` bumps them.

## RTK and shell policy

RTK optimizer config is declarative. Pi can edit RTK settings interactively, but Home Manager will restore this repo's config on next switch.

Important load-order quirk: `use-fish` must load last. RTK needs to see raw shell commands before they are wrapped as `fish -lc ...`; if Fish wrapping happens first, RTK sees `fish` as the command and silently misses rewrites.

Shell result: Pi gets Fish semantics while RTK still sees useful commands.

## NPM isolation

No global npm install is required.

Heavy JavaScript packages are built or linked through Nix:

- Bun/bun2nix for packages that need Bun dependency resolution;
- `buildNpmPackage` where upstream has suitable npm locks;
- direct tarball fetches for tiny packaged extensions;
- nixpkgs-provided Playwright MCP and browser dependencies;
- generated lock files in `locks/` where upstream does not ship the lock shape this repo needs.

Runtime command paths in `mcp.json` point into the Nix store. No `npx`, global npm, or runtime package fetch is needed for the default MCP stack.

## Patches

Local patches adapt upstream behavior:

| Patch | Intent |
| --- | --- |
| `pi-command-models-compact.patch` | Compact command model handling. |
| `pi-ai-discard-failed-tool-continuations.patch` | Avoid carrying failed tool continuations forward. |
| `pi-mcp-adapter-slab-status.patch` | Publish MCP status for Slab. |

## Quirks worth knowing

- `pi-lib` is support-only, but it also has a no-op extension entry so Pi's loader tolerates it.
- Directory extensions get `node_modules/@pi/lib` symlinks. This works around Node/Jiti realpath resolution when local extensions import `@pi/lib`.
- The subagent extension registers its model-facing tool only if another active `subagent` tool is not already present.
- Slab is the shared UI host. Other extensions publish statuses/widgets through `@pi/lib/ui/status-store`; Slab renders them.
- Sworm runtime state is mostly local under `.sworm/`; specs in `.sworm/sdd/` describe durable work loops.
- Desktop notifications can be disabled with `PI_DESKTOP_NOTIFY=0`, `false`, or `off`.
- Several prompts avoid starting with slash-command-shaped text because Pi may hijack the first token as a command.

## Repo map

```text
flake.nix                         flake outputs and package set
locks/                            generated Bun/package locks
modules/home/default.nix          Home Manager module and runtime wiring
modules/home/SOUL.md              global Pi agent prompt
modules/home/themes/terminal.json terminal theme
modules/home/lib/                 extension-system Nix helpers
modules/home/packages/            Nix package definitions for Pi add-ons
modules/home/patches/             local upstream patches
modules/home/extensions/pi-lib/   shared extension library
modules/home/extensions/slab/     terminal UI surface
modules/home/extensions/buddy/    companion, memory, reasoning, widgets
modules/home/extensions/sdd/      spec-driven development workflow
modules/home/extensions/review/   adversarial review workflow
modules/home/extensions/cleanup/  cleanup workflow
modules/home/extensions/agentic-qa/ QA workflow and report tool
modules/home/extensions/commands/ commit/PR/config commands
modules/home/extensions/burden/   token attribution explorer
modules/home/extensions/*.ts      small standalone extensions
.sworm/sdd/                       local spec docs and visuals
```

## One-line summary

`pi.nix` makes Pi reproducible, opinionated, scout-powered, UI-rich, MCP-aware, and unmistakably local to Toph's way of working.
