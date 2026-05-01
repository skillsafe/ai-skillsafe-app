import { describe, it, expect } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { makeDownloadEventHandler, type UpdateProgress } from "../src/lib/update/runner";

describe("makeDownloadEventHandler", () => {
  it("emits 0/total on Started, accumulates on Progress, switches phase on Finished", () => {
    const events: UpdateProgress[] = [];
    const handler = makeDownloadEventHandler((p) => events.push(p));

    handler({ event: "Started", data: { contentLength: 1000 } } as DownloadEvent);
    handler({ event: "Progress", data: { chunkLength: 300 } } as DownloadEvent);
    handler({ event: "Progress", data: { chunkLength: 700 } } as DownloadEvent);
    handler({ event: "Finished" } as DownloadEvent);

    expect(events).toEqual([
      { phase: "downloading", downloadedBytes: 0, totalBytes: 1000 },
      { phase: "downloading", downloadedBytes: 300, totalBytes: 1000 },
      { phase: "downloading", downloadedBytes: 1000, totalBytes: 1000 },
      { phase: "installing", downloadedBytes: 1000, totalBytes: 1000 },
    ]);
  });

  it("handles missing contentLength as null total", () => {
    const events: UpdateProgress[] = [];
    const handler = makeDownloadEventHandler((p) => events.push(p));

    handler({ event: "Started", data: {} } as DownloadEvent);
    handler({ event: "Progress", data: { chunkLength: 50 } } as DownloadEvent);

    expect(events[0].totalBytes).toBeNull();
    expect(events[1].downloadedBytes).toBe(50);
  });
});
