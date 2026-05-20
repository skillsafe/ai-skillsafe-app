import { describe, expect, it } from "vitest";
import {
  detectLockfileFormat,
  exportLockfile,
  foreignToSkillsafe,
  getAdapter,
  importLockfile,
} from "../src/lib/lockfile/formats";

describe("lockfile format detection", () => {
  it("identifies skillsafe-v1 by version + skills object", () => {
    const raw = JSON.stringify({
      version: 1,
      skills: { foo: { source: "s", sourceType: "t", computedHash: "h" } },
    });
    expect(detectLockfileFormat(raw)).toBe("skillsafe-v1");
  });

  it("identifies vercel by lockfileVersion key", () => {
    const raw = JSON.stringify({
      lockfileVersion: 1,
      skills: { foo: { version: "1.0.0", resolved: "https://x", integrity: "sha512-xx" } },
    });
    expect(detectLockfileFormat(raw)).toBe("vercel");
  });

  it("identifies pcomans by schemaVersion + skills array", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      skills: [{ name: "foo", source: { type: "git", url: "https://x" }, hash: "sha256:abc" }],
    });
    expect(detectLockfileFormat(raw)).toBe("pcomans");
  });

  it("identifies skillpm by skillpm namespace", () => {
    const raw = JSON.stringify({
      skillpm: { version: 1, packages: { foo: { version: "1.0.0", source: "registry:x" } } },
    });
    expect(detectLockfileFormat(raw)).toBe("skillpm");
  });

  it("identifies pixi by YAML header signature", () => {
    const raw = "# pixi-skills lockfile\nversion: 1\nskills:\n  - name: foo\n";
    expect(detectLockfileFormat(raw)).toBe("pixi");
  });

  it("returns unknown for unrecognized JSON", () => {
    expect(detectLockfileFormat('{"unrelated": true}')).toBe("unknown");
  });

  it("returns unknown for corrupt input", () => {
    expect(detectLockfileFormat("not json at all")).toBe("unknown");
  });
});

describe("skillsafe-v1 adapter", () => {
  it("round-trips through parse + serialize", () => {
    const raw = JSON.stringify(
      {
        version: 1,
        skills: {
          foo: { source: "api.example.com", sourceType: "well-known", computedHash: "abc" },
        },
      },
      null,
      2,
    );
    const foreign = importLockfile(raw);
    const back = exportLockfile(foreign);
    expect(JSON.parse(back)).toEqual(JSON.parse(raw));
  });

  it("preserves unknown per-skill fields", () => {
    const raw = JSON.stringify({
      version: 1,
      skills: {
        foo: {
          source: "x",
          sourceType: "y",
          computedHash: "z",
          custom_field: "preserved",
        },
      },
    });
    const back = JSON.parse(exportLockfile(importLockfile(raw)));
    expect(back.skills.foo.custom_field).toBe("preserved");
  });
});

describe("vercel adapter", () => {
  it("round-trips a typical entry", () => {
    const raw = JSON.stringify({
      lockfileVersion: 1,
      skills: {
        foo: {
          version: "1.2.3",
          resolved: "https://example.com/foo-1.2.3.tgz",
          integrity: "sha512-xx",
        },
      },
    });
    const foreign = importLockfile(raw);
    expect(foreign.format).toBe("vercel");
    expect(foreign.skills[0].version).toBe("1.2.3");
    expect(foreign.skills[0].source).toBe("https://example.com/foo-1.2.3.tgz");
    expect(foreign.skills[0].hash).toBe("sha512-xx");
    const back = JSON.parse(exportLockfile(foreign));
    expect(back.skills.foo.integrity).toBe("sha512-xx");
  });

  it("converts to skillsafe-v1 shape", () => {
    const raw = JSON.stringify({
      lockfileVersion: 1,
      skills: { foo: { version: "1.0", resolved: "https://x", integrity: "sha512-h" } },
    });
    const lock = foreignToSkillsafe(importLockfile(raw));
    expect(lock.version).toBe(1);
    expect(lock.skills.foo.computedHash).toBe("sha512-h");
    expect(lock.skills.foo.source).toBe("https://x");
  });

  it("preserves unknown top-level fields", () => {
    const raw = JSON.stringify({
      lockfileVersion: 1,
      vercelMeta: "preserve-me",
      skills: { foo: { version: "1", resolved: "u", integrity: "h" } },
    });
    const back = JSON.parse(exportLockfile(importLockfile(raw)));
    expect(back.vercelMeta).toBe("preserve-me");
  });
});

describe("pcomans adapter", () => {
  it("parses array-style skills with source object", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      skills: [
        {
          name: "foo",
          source: { type: "git", url: "https://github.com/x/y" },
          ref: "abc123",
          hash: "sha256:def",
        },
      ],
    });
    const foreign = importLockfile(raw);
    expect(foreign.skills[0].name).toBe("foo");
    expect(foreign.skills[0].sourceType).toBe("git");
    expect(foreign.skills[0].version).toBe("abc123");
    expect(foreign.skills[0].hash).toBe("sha256:def");
  });

  it("round-trips back to pcomans shape", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      skills: [{ name: "foo", source: { type: "git", url: "u" }, ref: "v1", hash: "h" }],
    });
    const back = JSON.parse(exportLockfile(importLockfile(raw)));
    expect(back.skills[0].source.type).toBe("git");
    expect(back.skills[0].source.url).toBe("u");
  });
});

describe("skillpm adapter", () => {
  it("parses skillpm namespace", () => {
    const raw = JSON.stringify({
      skillpm: {
        version: 1,
        packages: { foo: { version: "1.0.0", source: "registry:x", checksum: "h" } },
      },
    });
    const foreign = importLockfile(raw);
    expect(foreign.skills[0].version).toBe("1.0.0");
    expect(foreign.skills[0].hash).toBe("h");
    expect(foreign.skills[0].sourceType).toBe("registry");
  });

  it("round-trips through serialize", () => {
    const raw = JSON.stringify({
      skillpm: {
        version: 1,
        packages: { foo: { version: "1.0", source: "https://x", checksum: "h" } },
      },
    });
    const back = JSON.parse(exportLockfile(importLockfile(raw)));
    expect(back.skillpm.packages.foo.checksum).toBe("h");
  });
});

describe("pixi adapter (detect-only)", () => {
  it("detects pixi-skills YAML header", () => {
    const raw = "# pixi-skills lockfile\n";
    const adapter = getAdapter("pixi")!;
    expect(adapter.detect(raw, null)).toBe(true);
  });

  it("throws with guidance when parse is called", () => {
    expect(() => importLockfile("# pixi-skills lockfile\n")).toThrow(/pixi lockfile import not yet supported/);
  });
});

describe("unknown format", () => {
  it("importLockfile throws for unrecognized input", () => {
    expect(() => importLockfile("{}")).toThrow(/format not recognized/i);
  });
});
