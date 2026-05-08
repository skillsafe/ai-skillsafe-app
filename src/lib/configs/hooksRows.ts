import { HOOK_EVENTS, type HookEvent, type Hooks } from "./schemas";

// Editor-side flat row shape. The HooksEditor component builds rows from
// `flatten` and writes back via `coalesce`. Both helpers live here (not in
// the .tsx) so tests can import them without pulling in React/JSX.
export interface HookRow {
  event: HookEvent;
  matcher: string;
  command: string;
  timeout?: number;
}

export function flattenHooks(hooks: Hooks): HookRow[] {
  const out: HookRow[] = [];
  if (!hooks) return out;
  for (const ev of HOOK_EVENTS) {
    const groups = hooks[ev];
    if (!groups) continue;
    for (const group of groups) {
      for (const h of group.hooks) {
        out.push({
          event: ev,
          matcher: group.matcher ?? "",
          command: h.command,
          timeout: h.timeout,
        });
      }
    }
  }
  return out;
}

// Re-group rows by (event, matcher). Two rows for the same matcher under one
// event coalesce into a single hook group with two commands. Empty events
// drop out entirely so the disk shape stays minimal.
export function coalesceHooks(rows: HookRow[]): NonNullable<Hooks> {
  const out: NonNullable<Hooks> = {};
  for (const r of rows) {
    if (!r.command.trim()) continue;
    const event = r.event;
    const groups = out[event] ?? [];
    const matcher = r.matcher.trim() || undefined;
    let group = groups.find((g) => (g.matcher ?? "") === (matcher ?? ""));
    if (!group) {
      group = { matcher, hooks: [] };
      groups.push(group);
    }
    group.hooks.push({
      type: "command",
      command: r.command,
      ...(r.timeout ? { timeout: r.timeout } : {}),
    });
    out[event] = groups;
  }
  return out;
}
