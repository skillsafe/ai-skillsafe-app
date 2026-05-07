import { describe, expect, it } from "vitest";
import {
  findMarkerLine,
  formatScheduleFields,
  hasMarker,
  LINUX_CRON_MARKER,
  stripMarker,
} from "../src/lib/backup/linuxScheduler";

describe("linuxScheduler — crontab text manipulation", () => {
  it("hasMarker / findMarkerLine detect a tagged line", () => {
    const cron =
      "# user notes\n" +
      "0 9 * * * /home/me/wakeup.sh\n" +
      `15 12 * * * '/home/me/.local/share/skillsafe-app/scheduled-backup/claude_backup.sh' ${LINUX_CRON_MARKER}\n`;
    expect(hasMarker(cron)).toBe(true);
    expect(findMarkerLine(cron)).toMatch(LINUX_CRON_MARKER);
    expect(findMarkerLine(cron)).toMatch(/15 12 \* \* \*/);
  });

  it("hasMarker is false on a foreign crontab", () => {
    expect(hasMarker("0 9 * * * /home/me/wakeup.sh\n")).toBe(false);
    expect(hasMarker("")).toBe(false);
  });

  it("stripMarker removes only our line and preserves the rest", () => {
    const cron =
      "MAILTO=user@example.com\n" +
      "0 9 * * * /home/me/wakeup.sh\n" +
      `15 12 * * * '/path/to/backup.sh' ${LINUX_CRON_MARKER}\n` +
      "30 23 * * 0 /home/me/weekly.sh\n";
    const cleaned = stripMarker(cron);
    expect(cleaned).toContain("MAILTO=user@example.com");
    expect(cleaned).toContain("/home/me/wakeup.sh");
    expect(cleaned).toContain("/home/me/weekly.sh");
    expect(cleaned).not.toContain(LINUX_CRON_MARKER);
    expect(cleaned).not.toContain("'/path/to/backup.sh'");
  });

  it("formatScheduleFields emits the daily form when no weekdays are set", () => {
    expect(formatScheduleFields({ hour: 12, minute: 15, weekdays: null })).toBe(
      "15 12 * * *",
    );
    expect(formatScheduleFields({ hour: 0, minute: 0, weekdays: [] })).toBe(
      "0 0 * * *",
    );
  });

  it("formatScheduleFields emits a weekday list when weekdays are set", () => {
    expect(
      formatScheduleFields({ hour: 8, minute: 30, weekdays: [1, 2, 3, 4, 5] }),
    ).toBe("30 8 * * 1,2,3,4,5");
    // Deduplicates + sorts.
    expect(
      formatScheduleFields({ hour: 8, minute: 30, weekdays: [3, 1, 1, 0] }),
    ).toBe("30 8 * * 0,1,3");
  });

  it("formatScheduleFields clamps out-of-range hour/minute", () => {
    expect(formatScheduleFields({ hour: 99, minute: -5, weekdays: null })).toBe(
      "0 23 * * *",
    );
  });

  it("formatScheduleFields drops out-of-range weekdays silently", () => {
    expect(
      formatScheduleFields({ hour: 12, minute: 0, weekdays: [-1, 7, 3] }),
    ).toBe("0 12 * * 3");
  });
});
