import type { FsAdapter } from "../fs";
import { atomicWrite, ensureDir, safeExists } from "../fs";
import type { PathResolverDeps } from "../paths";
import type { PathJoiner } from "../artifacts/skill";
import type { Keybinding } from "./schemas";

export interface KeybindingsDoc {
  path: string;
  exists: boolean;
  bindings: Keybinding[];
  rest: Record<string, unknown>;
  rawText: string; // verbatim file contents — used by the Raw JSON tab
  mtimeMs: number | null;
}

export async function keybindingsPath(
  pj: PathJoiner,
  paths: PathResolverDeps,
): Promise<string> {
  const home = await paths.homeDir();
  return pj.join(home, ".claude", "keybindings.json");
}

export async function loadKeybindings(
  fs: FsAdapter,
  path: string,
): Promise<KeybindingsDoc> {
  if (!(await safeExists(fs, path))) {
    return {
      path,
      exists: false,
      bindings: [],
      rest: {},
      rawText: "",
      mtimeMs: null,
    };
  }
  const rawText = await fs.readTextFile(path);
  let parsed: Record<string, unknown> = {};
  if (rawText.trim().length > 0) {
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      // Defer the recovery to the Raw tab — the form view treats this as an
      // empty doc but the rawText is still available for hand-editing.
      parsed = {};
    }
  }
  const bindingsRaw = parsed.bindings;
  const bindings: Keybinding[] = Array.isArray(bindingsRaw)
    ? bindingsRaw.filter(isBinding)
    : [];
  const { bindings: _omit, ...rest } = parsed;
  let mtimeMs: number | null = null;
  try {
    mtimeMs = (await fs.stat(path)).mtimeMs;
  } catch {
    /* ignore */
  }
  return { path, exists: true, bindings, rest, rawText, mtimeMs };
}

export async function saveKeybindings(
  fs: FsAdapter,
  doc: KeybindingsDoc,
  bindings: Keybinding[],
): Promise<KeybindingsDoc> {
  const next: Record<string, unknown> = { ...doc.rest };
  if (bindings.length > 0) next.bindings = bindings;
  const dir = parentDir(doc.path);
  if (dir) await ensureDir(fs, dir);
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  await atomicWrite(fs, doc.path, serialized);
  return loadKeybindings(fs, doc.path);
}

// Lossless raw save: write the text the user typed in the Raw JSON tab
// without any normalization. Validates that it parses; everything past that
// is the user's responsibility.
export async function saveKeybindingsRaw(
  fs: FsAdapter,
  path: string,
  rawText: string,
): Promise<KeybindingsDoc> {
  // Reject obviously invalid JSON so we don't strand the user with a file
  // they can't reload through the form.
  if (rawText.trim().length > 0) {
    JSON.parse(rawText);
  }
  const dir = parentDir(path);
  if (dir) await ensureDir(fs, dir);
  await atomicWrite(fs, path, rawText.endsWith("\n") ? rawText : `${rawText}\n`);
  return loadKeybindings(fs, path);
}

function isBinding(b: unknown): b is Keybinding {
  if (!b || typeof b !== "object") return false;
  const obj = b as Record<string, unknown>;
  return typeof obj.action === "string" && typeof obj.keys === "string";
}

function parentDir(p: string): string | null {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return p.slice(0, idx);
}
