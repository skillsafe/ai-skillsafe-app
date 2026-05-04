import type { Tool } from "./artifacts/types";
import { isKnownAgent } from "./agents/registry";

export interface DeepLinkInstall {
  kind: "install";
  ns: string;
  name: string;
  version?: string;
  tool?: Tool;
}

export type DeepLinkIntent = DeepLinkInstall;

export function parseDeepLink(raw: string): DeepLinkIntent | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "skillsafe:") return null;
  // skillsafe://install?... → host = "install" on most platforms, but on some
  // (e.g. older WebViews) the action lands in pathname instead. Accept either.
  const action = url.host || url.pathname.replace(/^\/+/, "").split("/")[0] || "";
  if (action !== "install") return null;

  const ns = url.searchParams.get("ns")?.trim();
  const name = url.searchParams.get("name")?.trim();
  if (!ns || !name) return null;

  const version = url.searchParams.get("version")?.trim() || undefined;
  const toolRaw = url.searchParams.get("tool")?.trim();
  const tool = toolRaw && isKnownAgent(toolRaw) ? toolRaw : undefined;

  return { kind: "install", ns: ns.replace(/^@/, ""), name, version, tool };
}
