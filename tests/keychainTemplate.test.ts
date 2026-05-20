import { describe, expect, it } from "vitest";
import { rewriteToKeychain } from "../src/lib/secrets/keychainTemplate";

describe("keychainTemplate", () => {
  it("rewrites AWS_SECRET_KEY=… on macOS via `security`", () => {
    const result = rewriteToKeychain(
      `export AWS_SECRET_KEY=AKIA0123456789ABCDEFGHIJ\nrun-something\n`,
      { os: "darwin" },
    );
    expect(result.body).toContain("security find-generic-password");
    expect(result.body).toContain("-s 'skillsafe'");
    expect(result.body).toContain("-a 'AWS_SECRET_KEY'");
    expect(result.rewrittenKeys).toEqual(["AWS_SECRET_KEY"]);
  });

  it("rewrites on linux via secret-tool", () => {
    const result = rewriteToKeychain(
      `API_TOKEN="ghp_abcdefghijklmnopqrstuvwxyz1234567890"\n`,
      { os: "linux" },
    );
    expect(result.body).toContain("secret-tool lookup service");
    expect(result.rewrittenKeys).toEqual(["API_TOKEN"]);
  });

  it("rewrites on windows via powershell", () => {
    const result = rewriteToKeychain(`SECRET_KEY=abcdefghijklmnop\n`, { os: "windows" });
    expect(result.body).toContain("Get-StoredCredential");
    expect(result.body).toContain("skillsafe/SECRET_KEY");
  });

  it("uses custom service name when provided", () => {
    const result = rewriteToKeychain(`API_KEY=longenoughvalue\n`, { os: "darwin", service: "myapp" });
    expect(result.body).toContain("-s 'myapp'");
  });

  it("preserves trailing comments", () => {
    const result = rewriteToKeychain(`API_KEY=somesecretvalue  # the api key\n`, { os: "darwin" });
    expect(result.body).toContain("# the api key");
  });

  it("skips lines that don't look secret-like (short values)", () => {
    const result = rewriteToKeychain(`API_KEY=short\n`, { os: "darwin" });
    expect(result.rewrittenKeys).toEqual([]);
    expect(result.body).toBe("API_KEY=short\n");
  });

  it("skips lines that don't look secret-like (non-secret key names)", () => {
    const result = rewriteToKeychain(`LOG_LEVEL=info_with_enough_length\n`, { os: "darwin" });
    expect(result.rewrittenKeys).toEqual([]);
  });

  it("skips lines that already look like keychain lookups", () => {
    const result = rewriteToKeychain(`SECRET_KEY=security find-generic-password ...\n`, { os: "darwin" });
    expect(result.rewrittenKeys).toEqual([]);
  });

  it("skips shell expansions", () => {
    const result = rewriteToKeychain(`API_TOKEN=$(cat /tmp/whatever)\n`, { os: "darwin" });
    expect(result.rewrittenKeys).toEqual([]);
  });

  it("handles export prefix and indentation", () => {
    const result = rewriteToKeychain(`    export AWS_ACCESS_KEY=AKIA0123456789ABCDEFGH\n`, { os: "darwin" });
    expect(result.rewrittenKeys).toEqual(["AWS_ACCESS_KEY"]);
    expect(result.body).toMatch(/^\s+export AWS_ACCESS_KEY=/);
  });
});
