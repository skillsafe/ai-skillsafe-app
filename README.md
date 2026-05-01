# AI SkillSafe

A cross-platform desktop app for browsing, editing, creating, and converting markdown-frontmatter artifacts (**skills**, **agents**, **commands**) across **Claude Code**, **OpenAI Codex CLI**, **Cursor IDE**, **OpenClaw**, and **Cline**.

[![Build](https://github.com/skillsafe/ai-skillsafe-app/actions/workflows/release.yml/badge.svg)](https://github.com/skillsafe/ai-skillsafe-app/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/skillsafe/ai-skillsafe-app?include_prereleases&sort=semver)](https://github.com/skillsafe/ai-skillsafe-app/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/skillsafe/ai-skillsafe-app?style=social)](https://github.com/skillsafe/ai-skillsafe-app/stargazers)
[![Forks](https://img.shields.io/github/forks/skillsafe/ai-skillsafe-app?style=social)](https://github.com/skillsafe/ai-skillsafe-app/network/members)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/skillsafe/ai-skillsafe-app/pulls)

> If this project saves you a few minutes, please **[give it a star](https://github.com/skillsafe/ai-skillsafe-app/stargazers)** — it's the cheapest way to keep contributors motivated. Found a bug or want a feature? **[Open an issue](https://github.com/skillsafe/ai-skillsafe-app/issues/new/choose)** or send a PR.

Built on **Tauri 2 + React 19 + TypeScript**. The Rust shell is intentionally thin — every artifact-touching function lives in TypeScript under `src/lib/`.

## What it manages

| Tool       | Skills (auto-invoked)                       | Agents               | Commands (manual)        |
|------------|---------------------------------------------|----------------------|--------------------------|
| Claude     | `<scope>/skills/<name>/SKILL.md` (bundle)   | `<scope>/agents/*.md`| `<scope>/commands/*.md`  |
| Codex      | —                                           | `AGENTS.md`          | `~/.codex/prompts/*.md`  |
| Cursor     | `.cursor/rules/*.{md,mdc}`                  | —                    | —                        |
| OpenClaw   | `<scope>/skills/<name>/SKILL.md` (bundle)   | —                    | —                        |
| Cline      | `<scope>/.clinerules/*.{md,txt}`            | —                    | —                        |

Scopes: **Global** (`~/.claude`, `~/.codex`, `~/.cursor`, …) · **Project** (any folder you pick) · **Lockfile** (entries in `skills-lock.json`, with hash drift detection).

## Install (prebuilt binaries)

Grab the latest installer from the **[Releases page](https://github.com/skillsafe/ai-skillsafe-app/releases/latest)**:

- **macOS** (Apple Silicon + Intel, universal): `*_universal.dmg` — open and drag into `Applications`. On first launch macOS may say "unidentified developer" — right-click → **Open** once to bypass.
- **Windows**: `*_x64-setup.exe` (recommended) or `*_x64_en-US.msi` (for IT-managed installs).
- **Linux**: `*_amd64.AppImage` (`chmod +x` and run) or `*_amd64.deb` (`sudo apt install ./*.deb`).

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
npm run typecheck          # tsc --noEmit
npm run build              # tsc -b + vite build (frontend only)
npm run tauri build        # full desktop bundle (.dmg/.app/.deb/.AppImage/.msi/.exe)
```

`npm run tauri build` produces the same artifacts CI ships:
- macOS: `.dmg`, `.app.tar.gz` (+ `.sig` for the auto-updater)
- Windows: `.msi`, `.exe`, `.msi.zip` / `.nsis.zip` (+ `.sig`)
- Linux: `.deb`, `.AppImage`, `.AppImage.tar.gz` (+ `.sig`)

The CI matrix at `.github/workflows/release.yml` builds all three platforms; tagging a commit `v*` cuts a GitHub Release.

## Architecture

```
src/lib/
  paths.ts          per-tool path resolver (uses Tauri homeDir, OS-agnostic)
  fs.ts             FsAdapter contract + atomic writes + sha256
  frontmatter.ts    gray-matter wrapper (parse / stringify)
  validate.ts       zod schemas → also drives FrontmatterForm rendering
  artifacts/
    skill.ts        SKILL.md bundle: list, load, save (atomic), create, delete
    markdownFile.ts single-file artifacts (agents, commands, cursor rules)
  tools/
    claude.ts       lists skills/agents/commands across .claude/ and .agents/
    codex.ts        ~/.codex/prompts + AGENTS.md
    cursor.ts       .cursor/rules/*.{md,mdc}
    openclaw.ts     ~/.openclaw/skills (Claude-style SKILL.md bundles)
    cline.ts        .clinerules/*.{md,txt}
  lockfile.ts       skills-lock.json read + sha256 drift detection
  convert.ts        cross-tool transformer (skill ⇄ rule ⇄ prompt)
  store.ts          zustand state
  tauriAdapters.ts  binds FsAdapter + PathResolver to Tauri plugin APIs
  skillsafe/        skillsafe.ai cloud client (auth, install, scan reports)
  backup/           local backup runner + launchd / cron script generation
```

The Rust side (`src-tauri/`) only registers plugins (`fs`, `dialog`, `shell`, `os`, `http`, `updater`, `process`) and runs the window — there is no custom Rust business logic, by design. Extend the TypeScript adapters instead of adding Tauri commands.

## Verification checklist

1. `npm test` — round-trip frontmatter, skill bundle CRUD, path resolver per platform, convert transformers, lockfile drift.
2. `npm run tauri dev` — launches the app. Pick this repo as the project; the skills under `.agents/skills/` should appear under **Claude → Project → Skills**.
3. Edit a skill's `SKILL.md` description, **Save**, then `head` the file outside the app — the change is on disk.
4. Click → on a skill, choose **cursor → skill** — confirm `.cursor/rules/<name>.mdc` is written with `description` + `globs` mapped from `paths`.
5. Toggle to **Lockfile** scope — drifted bundles show a `drift` badge.

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

When adding a new tool or frontmatter field, update the Zod schema in `src/lib/validate.ts` — the form picks it up automatically. New library functions must take `FsAdapter` / `PathJoiner` / `PathResolverDeps` as parameters so they remain unit-testable under Node.

## License

[MIT](LICENSE) — do whatever you like, attribution appreciated.
