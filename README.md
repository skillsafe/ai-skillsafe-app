# AI SkillSafe

A cross-platform desktop app for browsing, editing, creating, converting, and **backing up** the markdown-frontmatter and config artifacts — skills, agents, commands, memory, MCP servers, hooks, permissions, keybindings — that drive **50+ AI coding agents** (Claude Code, Codex CLI, Cursor, Gemini CLI, Continue, Windsurf, OpenCode, Roo, Kilo, Cline, OpenClaw, …).

[![Build](https://github.com/skillsafe/ai-skillsafe-app/actions/workflows/release.yml/badge.svg)](https://github.com/skillsafe/ai-skillsafe-app/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/skillsafe/ai-skillsafe-app?include_prereleases&sort=semver)](https://github.com/skillsafe/ai-skillsafe-app/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/skillsafe/ai-skillsafe-app?style=social)](https://github.com/skillsafe/ai-skillsafe-app/stargazers)
[![Forks](https://img.shields.io/github/forks/skillsafe/ai-skillsafe-app?style=social)](https://github.com/skillsafe/ai-skillsafe-app/network/members)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/skillsafe/ai-skillsafe-app/pulls)

> If this project saves you a few minutes, please **[give it a star](https://github.com/skillsafe/ai-skillsafe-app/stargazers)** — it's the cheapest way to keep contributors motivated. Found a bug or want a feature? **[Open an issue](https://github.com/skillsafe/ai-skillsafe-app/issues/new/choose)** or send a PR.

Built on **Tauri 2 + React 19 + TypeScript**. The Rust shell is intentionally thin (plugin registration + deep-link plumbing); every artifact-touching function lives in TypeScript under `src/lib/`.

---

## Why it exists

Every AI coding agent — Claude Code, Codex CLI, Cursor, Gemini CLI, Continue, Windsurf, and dozens more — stores its **instructions, memory, MCP servers, hooks, permissions, and keybindings** in its *own* directory under its *own* layout. Power users end up with:

- The same project memory copy-pasted across `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …
- MCP servers re-declared in 4 different JSON shapes.
- Skills that exist in Claude but not Cursor, because nobody wants to translate the frontmatter by hand.
- No safety net when a tool update or a sloppy edit wipes a working config.

**AI SkillSafe gives you one window over all of it** — read, edit, translate, snapshot, restore, and share — without leaving the source-of-truth files on disk.

## Key features

### 1. One UI for 55+ AI coding agents

Surfaces the skills/agents/commands of **Claude Code, Codex CLI, Cursor, Gemini CLI, GitHub Copilot, Continue, Windsurf, OpenCode, OpenHands, Cline, OpenClaw, Roo, Kilo, Goose, Crush, Aider-Desk, Devin, Droid, Junie, Qoder, Qwen Code, Trae, Warp, Hermes, Antigravity, Augment, Replit, Zencoder, …** plus ~30 more. The full list is the agent registry at `src/lib/agents/registry.ts` (mirrored from [vercel-labs/skills](https://github.com/vercel-labs/skills/blob/main/src/agents.ts)), so adding a new tool is a one-entry pull request.

Every tool is scannable in three scopes: **Global** (`~/.claude`, `~/.codex`, `~/.cursor`, …), **Project** (any folder you pick), or **Lockfile** (entries in `skills-lock.json`, with sha-256 drift detection so you see when a bundle was edited out from under you).

### 2. Edit skills, agents, and commands with a real editor

The Artifacts view lists every `SKILL.md` bundle, agent prompt, and slash-command file across the active tool + scope. Click one and you get:

- An embedded **Monaco editor** for the markdown body — syntax highlighting, find/replace, multi-cursor.
- A **schema-driven form** for the frontmatter (description, model, tools, paths, globs…) generated from Zod schemas, so invalid YAML is impossible to save.
- **Attachments** — drag in additional files alongside `SKILL.md` (templates, sample data) and they're versioned with the bundle.
- **Atomic writes + sha-256 hashing** — saves are write-then-rename so the file is never half-written if the app crashes mid-save.
- **Edit history** — per-file undo stack with diff view; revert any change since you first opened the file.

### 3. Cross-tool conversion and transfer

Skills, rules, and slash-prompts are *almost* the same idea written in incompatible frontmatter dialects. The app translates between them:

- **Convert** turns a Claude `SKILL.md` into a Cursor `.cursor/rules/<name>.mdc` (mapping `paths` → `globs`), a Codex prompt, or an OpenClaw bundle — and back.
- **Transfer** copies an artifact from one tool's directory tree to another's, applying the right conversion along the way.
- **Translate** handles the structured-config equivalents: memory files (`CLAUDE.md` ↔ `AGENTS.md` ↔ `.cursorrules`) and MCP server blocks across the JSON/TOML shapes each tool expects.

### 4. Configs view — MCP, hooks, permissions, keybindings

Structured-JSON config files get a dedicated editor instead of a raw textbox:

- **MCP servers** — add/remove rows, switch transports (stdio / SSE / HTTP), and **merge** the MCP set from another tool into the current one in one click.
- **Hooks** — form-driven editing for pre/post-tool, user-prompt-submit, session-start, etc.
- **Permissions** — allow/deny tool patterns, with separate tabs for project-shared (`settings.json`, checked into git) and project-local (`settings.local.json`, gitignored) tiers.
- **Keybindings** — overrides for Claude Code's editor shortcuts.

### 5. Workbench — every category of state, in one place

A single scan covers the full universe of per-tool state — **skills, agents, commands, memory files, MCP servers, hooks, permissions, keybindings, transcripts** — across every installed agent. From the unified inventory you can:

- Open any file in the embedded editor.
- **Add to Master** — promote items into a canonical, user-versionable **master folder** that aggregates equivalent content across tools. One master memory file fans out to `CLAUDE.md`, `AGENTS.md`, `.cursorrules`. Drift between master and any source is detected on every scan and can be reconciled either direction.
- **Transfer** items between tools with the right conversion applied.
- **Categorize** items into custom groups for batch operations.

### 6. Backups — one-shot and scheduled

A first-class backup system, not an afterthought:

- **Pick a destination folder** (local disk, iCloud Drive, Dropbox, a synced repo, an external drive) and the app snapshots every artifact + config + memory + transcript across every tool you have installed.
- **One-click runs** from the bottom panel, or **per-row** from any artifact list.
- **Schedule it** — the app generates a `launchd` plist (macOS), a `cron` entry (Linux), or a `schtasks` XML task (Windows) and installs it. Backups then run even when the app is closed. The bottom panel polls the OS scheduler and **tails the live log** so you can see the most recent run.
- **Incremental + content-hashed** — unchanged files are not re-copied; each snapshot writes a `manifest.json` listing every file's sha-256.
- **Restore** — browse historical snapshots, **diff against current on-disk state** before applying, and bulk-restore a selection back into the live tool directories.

### 7. Cloud catalog and Skill Sets (optional)

Sign in with a free [skillsafe.ai](https://skillsafe.ai) account to:

- **Browse and install** public skills + curated **Skill Sets** (bundles of related skills/agents/configs) into any scope with one click.
- **Publish your own** skills as private, shared, or public, and see install / star / verification counts.
- **Scan reports** — every uploaded bundle is statically scanned for risky shell calls, secret leaks, and prompt-injection patterns; you see the findings before installing anything.
- **Share links** — hand a one-time URL to a teammate; they accept it and the skill lands in their app.
- **Deep links** — `skillsafe://install?ns=<owner>&name=<skill>&version=<v>&tool=<agent>` is honored on macOS, Windows, and Linux, so an "Install in AI SkillSafe" button on the web hands off cleanly to the desktop app.

You never have to sign in — all local features work fully offline.

### 8. Auto-update on every platform

The app self-updates via the Tauri updater plugin against `https://app.skillsafe.ai/version.json` (with a GitHub Releases fallback). Linux AppImages use **zsync** for incremental delta updates instead of redownloading the whole image. Every update is signed with a minisign key — unsigned or mismatched bundles are refused.

### 9. Six-language UI

Ships with **English, Deutsch, Español, Français, 日本語, 简体中文**. Locale is auto-detected from the OS and overridable from the in-app Settings dialog. Strings use ICU MessageFormat so plurals and gender render correctly.

### 10. Local-first, no telemetry, no server lock-in

- All artifact data lives **on your disk in its native format** — uninstalling the app leaves your tools fully working.
- The Rust core is **300 lines of plugin registration**; everything else is auditable TypeScript.
- No analytics, no usage tracking, no required account.
- MIT licensed.

## Install (prebuilt binaries)

Grab the latest installer from the **[Releases page](https://github.com/skillsafe/ai-skillsafe-app/releases/latest)** or **[app.skillsafe.ai/download](https://app.skillsafe.ai/download)**:

- **macOS** (Apple Silicon + Intel, universal): `*_universal.dmg` — open and drag into `Applications`. On first launch macOS may say "unidentified developer" — right-click → **Open** once to bypass.
- **Windows**: `*_x64-setup.exe` (NSIS, recommended).
- **Linux**: `*_amd64.AppImage` (`chmod +x` and run) or `*_amd64.deb` (`sudo apt install ./*.deb`). ARM builds are tagged `_aarch64.AppImage` / `_arm64.deb`.

Once installed, the app self-updates in the background (see feature #8 above).

## Build from source

### Prerequisites

- **Node.js 22+** and **npm**
- **Rust toolchain** (stable) — install via [rustup](https://rustup.rs/)
- **Platform deps** for Tauri 2 — see the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/):
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Windows**: Microsoft Visual Studio C++ Build Tools + WebView2 (preinstalled on Windows 11)
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`
    ```bash
    sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
    ```

### Clone, install, run

```bash
git clone https://github.com/skillsafe/ai-skillsafe-app.git
cd ai-skillsafe-app
npm install
npm run tauri dev          # launches the desktop app with Vite HMR
```

### Other commands

```bash
npm run dev                # web-only Vite (Tauri APIs will throw)
npm test                   # vitest, runs once
npm run test:watch         # vitest watch mode
npm run typecheck          # tsc -b --noEmit
npm run build              # tsc -b + vite build (frontend only)
npm run tauri build        # full desktop bundle
npm run ui-drive           # Playwright-driven UI script runner (see scripts/ui-driver/)
```

`npm run tauri build` produces the same artifacts CI ships:

- macOS: `.app`, `.dmg`, `.app.tar.gz` (+ `.sig`)
- Windows: `.exe` (NSIS), `.nsis.zip` (+ `.sig`)
- Linux: `.deb`, `.AppImage`, `.AppImage.tar.gz` (+ `.sig`)

The CI matrix at `.github/workflows/release.yml` builds all three platforms; tagging a commit `v*` cuts a GitHub Release with signed updater artifacts.

## Architecture

```
src-tauri/                 thin Rust shell — only plugin registration + deep-link relay
src/
  App.tsx                  three-view router: Artifacts | Configs | Workbench
  components/              ~45 React components (Workbench, ConfigsPanel, BackupPanel,
                             RemoteList, McpEditor, HooksEditor, PermissionsEditor,
                             KeybindingsEditor, ConvertDialog, TransferDialog, …)
  i18n/                    react-i18next + ICU, 6 locales under locales/
  lib/
    paths.ts               per-tool path resolver (Tauri homeDir, OS-agnostic)
    fs.ts                  FsAdapter contract + atomic writes + sha256
    frontmatter.ts         gray-matter wrapper (parse / stringify)
    validate.ts            zod schemas → also drive FrontmatterForm rendering
    markdown.ts            marked-based renderer for previews
    deepLink.ts            skillsafe:// URL parser
    store.ts               zustand state (view, scope, tool, scan results, cloud, …)
    tauriAdapters.ts       binds FsAdapter + PathResolver to Tauri plugin APIs
    artifacts/             SKILL.md bundle + single-file artifact CRUD
    tools/                 per-tool listers (claude, codex, generic)
    agents/                registry of 50+ supported agents (mirrors vercel-labs/skills)
    configs/               MCP / hooks / permissions / keybindings / settings.json
    inventory/             Workbench-wide scanner across all categories
    master/                canonical master folder + drift tracking
    category/              category-driven file sources
    backup/                runBackup, manifest, restore, OS schedulers
                             (launchd / cron / Task Scheduler), log tailing
    convert.ts             cross-tool transformers (skill ⇄ rule ⇄ prompt)
    translate/             MCP + memory cross-tool translation
    lockfile.ts            skills-lock.json read + sha256 drift detection
    editHistory/           per-file undo / diff store
    preview/               file classification + preview loader
    skillsafe/             skillsafe.ai cloud client (auth, install, sets, scan)
    update/                Tauri updater orchestration
    hooks/                 React hooks (useWorkbenchData, …)
```

The Rust side only registers plugins (`fs`, `dialog`, `shell`, `os`, `http`, `updater`, `process`, `deep-link`, `single-instance`) and runs the window — there is no custom Rust business logic, by design. Extend the TypeScript adapters instead of adding Tauri commands.

## Verification checklist

1. `npm test` — round-trip frontmatter, skill bundle CRUD, path resolver per platform, convert transformers, lockfile drift, backup manifest, deep-link parser.
2. `npm run typecheck` — clean.
3. `npm run tauri dev` — launches the app. Pick this repo as the project; the skills under `.agents/skills/` should appear under **Claude → Project → Skills**.
4. Edit a skill's `SKILL.md` description, **Save**, then `head` the file outside the app — the change is on disk.
5. Open the **Transfer** menu on a skill, choose **claude → cursor** — confirm `.cursor/rules/<name>.mdc` is written with `description` + `globs` mapped from `paths`.
6. Toggle to **Lockfile** scope — drifted bundles show a `drift` badge.
7. Open **Workbench**, pick a tool with on-disk state — every category (skills, agents, commands, memory, MCP, hooks, permissions, keybindings) populates.
8. Open the **Backup** bottom panel, pick a destination, run one — the destination contains a timestamped snapshot plus a `manifest.json`.

## Contributing

Contributions are very welcome — this project moves faster with your help.

- **[⭐ Star the repo](https://github.com/skillsafe/ai-skillsafe-app/stargazers)** if you find it useful — it really does help.
- **[🐛 File an issue](https://github.com/skillsafe/ai-skillsafe-app/issues/new/choose)** for bugs, feature requests, or questions.
- **[🍴 Fork it](https://github.com/skillsafe/ai-skillsafe-app/fork)** and send a PR — small fixes and big features both appreciated.
- **[💬 Start a discussion](https://github.com/skillsafe/ai-skillsafe-app/discussions)** if you're not sure something belongs as an issue yet.

Before opening a non-trivial PR, please run:

```bash
npm run typecheck && npm test
```

When adding a new tool, add an entry to `src/lib/agents/registry.ts` (mirroring the upstream `vercel-labs/skills` config when possible). When adding a new frontmatter field, update the Zod schema in `src/lib/validate.ts` — the form picks it up automatically. New library functions must take `FsAdapter` / `PathJoiner` / `PathResolverDeps` as parameters so they remain unit-testable under Node.

## License

[MIT](LICENSE) — do whatever you like, attribution appreciated.
