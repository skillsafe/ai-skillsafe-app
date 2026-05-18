// Install a SKILL.md bundle directly from a public GitHub repository.
//
// Skills distributed through `gh skill install owner/repo[@ref]` (or just
// referenced as a Git URL) live outside the skillsafe.ai registry, but their
// on-disk shape is identical: a SKILL.md plus optional attachments. We
// download the repository's zipball for the requested ref, locate every
// SKILL.md within it, and install the matching folder(s) into the same
// per-tool target dir resolveInstallDir uses for cloud skills.
//
// Provenance (owner, repo, ref, sha-256 of SKILL.md, pinned flag) is
// recorded in git-sources.json next to skills-lock.json so a later "Check
// for updates" pass can detect drift and propose an upgrade.

import { unzipSync, strFromU8 } from "fflate";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { FsAdapter } from "../fs";
import { ensureDir, sha256Hex } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { PathResolverDeps } from "../paths";
import type { Scope, Tool } from "../artifacts/types";
import { resolveInstallDir } from "./install";

export interface GitInstallRequest {
  owner: string;
  repo: string;
  /** Branch, tag, or commit SHA. Defaults to the repo's default branch. */
  ref?: string;
  /**
   * When `pin: true`, the resolver records the exact commit SHA returned by
   * the GitHub API (resolved from `ref`) so a later upgrade won't silently
   * move to a different commit on the same branch.
   */
  pin?: boolean;
  /**
   * Optional SKILL.md subpath. When set, only that bundle is installed;
   * otherwise every SKILL.md in the repo is installed.
   */
  subpath?: string;
}

export interface GitInstalledBundle {
  /** Folder name written under the tool's skills dir. */
  name: string;
  /** Absolute install dir. */
  targetDir: string;
  /** Files written, relative to targetDir. */
  entries: string[];
  /** sha-256 of the SKILL.md as installed. */
  skillHash: string;
}

export interface GitInstallResult {
  owner: string;
  repo: string;
  ref: string;
  /** Resolved commit SHA when `pin` was requested or when GitHub returns one. */
  commit?: string;
  bundles: GitInstalledBundle[];
}

/** Parse user input forms: `owner/repo`, `owner/repo@ref`, full GitHub URL. */
export function parseGitSpec(input: string): GitInstallRequest | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // GitHub HTTPS URL form.
  const urlMatch = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?@]+?)(?:\.git)?(?:\/tree\/([^/#?]+)(?:\/(.+?))?)?\/?$/i,
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      ref: urlMatch[3] || undefined,
      subpath: urlMatch[4] || undefined,
    };
  }
  // Short form: owner/repo[@ref][:subpath]
  const m = trimmed.match(/^([^/\s@:]+)\/([^/\s@:]+)(?:@([^:\s]+))?(?::(.+))?$/);
  if (m) {
    return { owner: m[1], repo: m[2], ref: m[3] || undefined, subpath: m[4] || undefined };
  }
  return null;
}

interface BrowserGlobal {
  __TAURI_INTERNALS__?: unknown;
}

// Resolved lazily on every call so tests can stub `globalThis.fetch` and
// Tauri's runtime injection lands before the first network read.
function httpFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const isTauri = !!(globalThis as BrowserGlobal).__TAURI_INTERNALS__;
  return isTauri
    ? (tauriFetch as unknown as typeof fetch)(input, init)
    : globalThis.fetch(input, init);
}

async function downloadZip(owner: string, repo: string, ref: string): Promise<Uint8Array> {
  // codeload serves a zip with no auth required for public repos. Form:
  //   https://codeload.github.com/<owner>/<repo>/zip/refs/heads/<branch>
  //   https://codeload.github.com/<owner>/<repo>/zip/<sha>
  // The /zip/<ref> shorthand resolves branches, tags, or commit SHAs.
  const url = `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref)}`;
  const res = await httpFetch(url, { method: "GET" });
  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status} for ${owner}/${repo}@${ref}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

interface ResolvedRef {
  /** The ref string the user can actually fetch (branch/tag/sha). */
  ref: string;
  /** Commit SHA, when we were able to resolve one. */
  commit?: string;
}

async function resolveRef(
  owner: string,
  repo: string,
  ref?: string,
): Promise<ResolvedRef> {
  // For pin-mode we want the exact commit SHA. The public refs API works
  // without auth (rate-limited per IP). Fall back to the raw ref name on
  // any failure — we can still download by name.
  if (ref && /^[a-f0-9]{7,40}$/i.test(ref)) {
    return { ref, commit: ref.toLowerCase() };
  }
  const tryUrl = async (u: string): Promise<string | null> => {
    try {
      const res = await httpFetch(u, {
        method: "GET",
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { object?: { sha?: string }; sha?: string };
      return j.object?.sha ?? j.sha ?? null;
    } catch {
      return null;
    }
  };
  if (ref) {
    const sha =
      (await tryUrl(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${ref}`)) ??
      (await tryUrl(`https://api.github.com/repos/${owner}/${repo}/git/refs/tags/${ref}`)) ??
      (await tryUrl(`https://api.github.com/repos/${owner}/${repo}/commits/${ref}`));
    return { ref, commit: sha ?? undefined };
  }
  // No ref → resolve the default branch's tip.
  try {
    const res = await httpFetch(`https://api.github.com/repos/${owner}/${repo}`, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json" },
    });
    if (res.ok) {
      const j = (await res.json()) as { default_branch?: string };
      if (j.default_branch) {
        const sha = await tryUrl(
          `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${j.default_branch}`,
        );
        return { ref: j.default_branch, commit: sha ?? undefined };
      }
    }
  } catch { /* fall through */ }
  return { ref: "HEAD" };
}

export async function installFromGit(
  fs: FsAdapter,
  deps: PathResolverDeps,
  pj: PathJoiner,
  opts: GitInstallRequest & { tool: Tool; scope: Scope; projectRoot?: string },
): Promise<GitInstallResult> {
  const resolved = await resolveRef(opts.owner, opts.repo, opts.ref);
  const effectiveRef = opts.pin && resolved.commit ? resolved.commit : resolved.ref;
  const zipBytes = await downloadZip(opts.owner, opts.repo, effectiveRef);
  const files = unzipSync(zipBytes);

  // codeload zips wrap everything in a top-level `<repo>-<sha>/` folder.
  // Strip it so on-disk paths match what's in the repo.
  const stripPrefix = ((): string => {
    for (const path of Object.keys(files)) {
      const slash = path.indexOf("/");
      if (slash > 0) return path.slice(0, slash + 1);
    }
    return "";
  })();

  // Locate every SKILL.md (or the one matching opts.subpath).
  const skillFiles: Array<{ archivePath: string; repoPath: string }> = [];
  for (const archivePath of Object.keys(files)) {
    if (!archivePath.endsWith("/SKILL.md")) continue;
    const repoPath = archivePath.startsWith(stripPrefix)
      ? archivePath.slice(stripPrefix.length)
      : archivePath;
    if (opts.subpath) {
      // Accept either the full path to SKILL.md or the bundle dir.
      const want = opts.subpath.replace(/\/+$/, "");
      const bundleDir = repoPath.slice(0, repoPath.length - "/SKILL.md".length);
      if (bundleDir !== want && repoPath !== want) continue;
    }
    skillFiles.push({ archivePath, repoPath });
  }

  if (skillFiles.length === 0) {
    throw new Error(
      opts.subpath
        ? `No SKILL.md found at ${opts.subpath} in ${opts.owner}/${opts.repo}@${effectiveRef}`
        : `No SKILL.md found in ${opts.owner}/${opts.repo}@${effectiveRef}`,
    );
  }

  const bundles: GitInstalledBundle[] = [];
  for (const { archivePath, repoPath } of skillFiles) {
    const bundleArchiveDir = archivePath.slice(0, archivePath.length - "SKILL.md".length); // ends with "/"
    // For a top-level SKILL.md (no parent folder inside the repo) use the
    // repo name itself as the bundle name; otherwise the immediate parent.
    const rel = repoPath === "SKILL.md" ? "" : repoPath.slice(0, repoPath.length - "/SKILL.md".length);
    const bundleName = lastSegment(rel) || opts.repo;
    const targetDir = await resolveInstallDir(
      deps,
      pj,
      opts.tool,
      opts.scope,
      opts.projectRoot,
      bundleName,
    );
    await ensureDir(fs, targetDir);
    const entries: string[] = [];
    let skillHash = "";
    for (const archive of Object.keys(files)) {
      if (!archive.startsWith(bundleArchiveDir)) continue;
      const inBundle = archive.slice(bundleArchiveDir.length);
      if (!inBundle || inBundle.endsWith("/")) continue; // directory entry
      if (inBundle.startsWith("/") || inBundle.split(/[\\/]/).includes("..")) {
        throw new Error(`Refusing unsafe path: ${inBundle}`);
      }
      const segments = inBundle.split("/");
      let cur = targetDir;
      for (let i = 0; i < segments.length - 1; i++) {
        cur = await pj.join(cur, segments[i]);
        await ensureDir(fs, cur);
      }
      const full = await pj.join(cur, segments[segments.length - 1]);
      const bytes = files[archive];
      if (fs.writeFile) {
        await fs.writeFile(full, bytes);
      } else {
        await fs.writeTextFile(full, strFromU8(bytes));
      }
      entries.push(inBundle);
      if (inBundle === "SKILL.md") {
        skillHash = await sha256Hex(strFromU8(bytes));
      }
    }
    bundles.push({ name: bundleName, targetDir, entries, skillHash });
  }

  return {
    owner: opts.owner,
    repo: opts.repo,
    ref: effectiveRef,
    commit: resolved.commit,
    bundles,
  };
}

function lastSegment(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}
