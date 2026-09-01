import { describe, expect, it } from "vitest";
import { presetRange } from "./date-range";
describe("date presets", () => {
  const now = new Date(2026, 8, 1, 12);
  it("uses local calendar boundaries", () => {
    expect(presetRange("today", now)?.[0].getHours()).toBe(0);
    expect(presetRange("week", now)?.[0].getDay()).toBe(1);
    expect(presetRange("month", now)?.[0].getDate()).toBe(1);
  });
  it("includes today in recent-day ranges", () => {
    const range = presetRange("last7", now)!;
    expect((range[1].getTime() - range[0].getTime() + 1) / 86_400_000).toBe(7);
  });
});
