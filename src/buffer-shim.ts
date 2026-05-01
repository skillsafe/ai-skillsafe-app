// gray-matter calls Buffer.from() in Node; in the Tauri webview Buffer is undefined.
// We never use file.orig downstream, so a pass-through is safe.
const g = globalThis as { Buffer?: { from: (s: unknown) => unknown; isBuffer: (v: unknown) => boolean } };
if (!g.Buffer) {
  g.Buffer = { from: (s) => s, isBuffer: () => false };
}
