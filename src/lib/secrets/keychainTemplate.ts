// Per-OS keychain rewriter. Replaces `KEY=value` style env exports + plain
// `EXPORT KEY=value` lines with a keychain lookup, so a SKILL.md containing
// inline secrets gets transformed into a SKILL.md that pulls from the OS
// secrets store at run time.
//
// Pure function — caller passes the body and target OS; this module decides
// what to substitute and returns a new body. Persisting the rewrite (and
// setting the `skillsafe.status: rewritten` sentinel) is the caller's job.

export type RewriteOs = "darwin" | "linux" | "windows";

export interface RewriteOptions {
  os: RewriteOs;
  /** Service name to use when storing the secret in keychain. Defaults to
   * "skillsafe" so all rewrites land in one namespace. */
  service?: string;
}

export interface RewriteResult {
  body: string;
  /** Names of keys that were rewritten — useful for the UI to remind the
   * user to actually populate the keychain entries afterwards. */
  rewrittenKeys: string[];
}

const INLINE_EXPORT = /^(\s*(?:export\s+)?)([A-Z][A-Z0-9_]+)\s*=\s*(["']?)([^"'\n#]+)\3\s*(#.*)?$/gm;

export function rewriteToKeychain(body: string, options: RewriteOptions): RewriteResult {
  const service = options.service ?? "skillsafe";
  const rewritten: string[] = [];
  const out = body.replace(INLINE_EXPORT, (match, lead, key, _quote, value, trailing) => {
    if (!looksSecretLike(key, value)) return match;
    rewritten.push(key);
    const lookup = renderLookup(options.os, service, key);
    const tail = trailing ? ` ${trailing}` : "";
    return `${lead}${key}=${lookup}${tail}`;
  });
  return { body: out, rewrittenKeys: [...new Set(rewritten)] };
}

/**
 * Decides if a `KEY=value` pair is plausibly a secret. We err on the side
 * of false positives because the user reviews each rewrite in the diff
 * preview before applying.
 */
function looksSecretLike(key: string, value: string): boolean {
  if (value.length < 8) return false;
  if (value.startsWith("$") || value.startsWith("`")) return false; // already a shell expansion
  if (/^(security|secret-tool|cmdkey|keyring)\b/.test(value)) return false; // already a keychain lookup
  const hints = /(KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL|API)/;
  return hints.test(key);
}

function renderLookup(os: RewriteOs, service: string, key: string): string {
  const account = key;
  switch (os) {
    case "darwin":
      // `security find-generic-password -s <service> -a <account> -w` prints
      // the raw secret to stdout. Command-substitute it so the env var
      // receives the value at process start.
      return `$(security find-generic-password -s ${shellSingle(service)} -a ${shellSingle(account)} -w)`;
    case "linux":
      // libsecret CLI (`secret-tool`). Standard on Ubuntu/Debian via
      // libsecret-tools; users on other distros can install it.
      return `$(secret-tool lookup service ${shellSingle(service)} account ${shellSingle(account)})`;
    case "windows":
      // PowerShell-friendly fallback using the Windows Credential Manager via
      // a small inline script. `cmdkey` itself can't print secrets, so we
      // shell out to PowerShell's CredentialManager API instead.
      return `$(powershell -NoProfile -Command "(Get-StoredCredential -Target '${psEscape(service)}/${psEscape(account)}').GetNetworkCredential().Password")`;
  }
}

function shellSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function psEscape(value: string): string {
  return value.replace(/'/g, "''");
}
