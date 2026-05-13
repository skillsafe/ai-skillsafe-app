import { describe, expect, it } from "vitest";
import {
  fileBasename,
  hasTextBasenameHint,
  inferLanguage,
  isImage,
  isLikelyBinary,
  isMarkdown,
  looksLikeBinaryBytes,
  MAX_PREVIEW_BYTES,
  prettyForPreview,
} from "../src/lib/preview/fileClassify";

describe("fileClassify", () => {
  describe("fileBasename", () => {
    it("returns last segment for posix paths", () => {
      expect(fileBasename("/a/b/c.txt")).toBe("c.txt");
    });
    it("returns last segment for windows paths", () => {
      expect(fileBasename("C:\\foo\\bar\\baz.log")).toBe("baz.log");
    });
    it("returns input when no separator", () => {
      expect(fileBasename("Makefile")).toBe("Makefile");
    });
  });

  describe("isImage", () => {
    it("matches common image extensions", () => {
      for (const e of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]) {
        expect(isImage(`thing.${e}`)).toBe(true);
      }
    });
    it("is case-insensitive", () => {
      expect(isImage("ICON.PNG")).toBe(true);
    });
    it("rejects non-images", () => {
      expect(isImage("foo.txt")).toBe(false);
      expect(isImage("foo.pdf")).toBe(false);
    });
  });

  describe("isMarkdown", () => {
    it("matches md / mdx / markdown", () => {
      expect(isMarkdown("README.md")).toBe(true);
      expect(isMarkdown("post.mdx")).toBe(true);
      expect(isMarkdown("notes.markdown")).toBe(true);
    });
    it("rejects other extensions", () => {
      expect(isMarkdown("README.txt")).toBe(false);
    });
  });

  describe("isLikelyBinary", () => {
    it("matches archives, executables, fonts, media", () => {
      const cases = ["app.zip", "tool.exe", "lib.dylib", "video.mp4", "song.mp3", "font.woff2", "doc.pdf"];
      for (const name of cases) {
        expect(isLikelyBinary(name)).toBe(true);
      }
    });
    it("excludes images so the image-preview path handles them", () => {
      expect(isLikelyBinary("foo.png")).toBe(false);
      expect(isLikelyBinary("foo.jpg")).toBe(false);
    });
    it("returns false for text-like files", () => {
      expect(isLikelyBinary("notes.txt")).toBe(false);
      expect(isLikelyBinary("config.json")).toBe(false);
      expect(isLikelyBinary("server.rs")).toBe(false);
      expect(isLikelyBinary("Makefile")).toBe(false);
    });
  });

  describe("hasTextBasenameHint", () => {
    it("matches common no-extension text files", () => {
      expect(hasTextBasenameHint("README")).toBe(true);
      expect(hasTextBasenameHint("LICENSE")).toBe(true);
      expect(hasTextBasenameHint("Makefile")).toBe(true);
    });
    it("rejects unrelated basenames", () => {
      expect(hasTextBasenameHint("foo.bin")).toBe(false);
    });
  });

  describe("inferLanguage", () => {
    it("maps jsonl/ndjson to json (Monaco renders them as JSON)", () => {
      expect(inferLanguage("transcript.jsonl")).toBe("json");
      expect(inferLanguage("stream.ndjson")).toBe("json");
    });
    it("maps source extensions to Monaco language ids", () => {
      expect(inferLanguage("main.rs")).toBe("rust");
      expect(inferLanguage("App.tsx")).toBe("typescript");
      expect(inferLanguage("init.py")).toBe("python");
      expect(inferLanguage("style.scss")).toBe("scss");
    });
    it("falls back to plaintext for unknown extensions", () => {
      expect(inferLanguage("data.xyz")).toBe("plaintext");
      expect(inferLanguage("Makefile")).toBe("plaintext");
    });
  });

  describe("prettyForPreview", () => {
    it("pretty-prints single JSON", () => {
      const out = prettyForPreview("a.json", '{"a":1,"b":[2,3]}');
      expect(out).toBe(`{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}`);
    });
    it("expands JSONL with blank-line separators", () => {
      const out = prettyForPreview("t.jsonl", '{"a":1}\n{"b":2}\n');
      expect(out).toBe(`{\n  "a": 1\n}\n\n{\n  "b": 2\n}`);
    });
    it("falls back to raw text on malformed JSON", () => {
      const out = prettyForPreview("a.json", "not actually json");
      expect(out).toBe("not actually json");
    });
    it("keeps unrecognised content untouched", () => {
      expect(prettyForPreview("notes.txt", "hello world")).toBe("hello world");
    });
  });

  describe("looksLikeBinaryBytes", () => {
    it("returns true when a NUL byte is in the first 8 KB", () => {
      const bytes = new Uint8Array([72, 101, 108, 108, 111, 0, 87]);
      expect(looksLikeBinaryBytes(bytes)).toBe(true);
    });
    it("returns false for plain UTF-8 text", () => {
      const bytes = new TextEncoder().encode("hello world\nline 2\n");
      expect(looksLikeBinaryBytes(bytes)).toBe(false);
    });
    it("only sniffs the first 8 KB", () => {
      const text = "x".repeat(8192);
      const bytes = new Uint8Array(8193);
      for (let i = 0; i < 8192; i++) bytes[i] = text.charCodeAt(0);
      bytes[8192] = 0; // NUL just past the sniff window
      expect(looksLikeBinaryBytes(bytes)).toBe(false);
    });
  });

  describe("MAX_PREVIEW_BYTES", () => {
    it("is generous enough for typical text + small enough to keep UI responsive", () => {
      expect(MAX_PREVIEW_BYTES).toBeGreaterThanOrEqual(1 * 1024 * 1024);
      expect(MAX_PREVIEW_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
    });
  });
});
