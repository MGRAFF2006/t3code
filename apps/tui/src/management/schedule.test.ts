import { describe, expect, it } from "vite-plus/test";
import { parseSchedule } from "./schedule.ts";

describe("scheduled task form parsing", () => {
  it("keeps fixed-time schedules in the server time zone and validates their weekdays", () => {
    expect(parseSchedule({ schedule: "fixed_time", time: "09:15", weekdays: "1,3,1,5" })).toEqual({
      type: "fixed_time",
      timeOfDay: "09:15",
      weekdays: [1, 3, 5],
    });
    expect(() => parseSchedule({ schedule: "fixed_time", time: "25:00" })).toThrow("HH:MM");
    expect(() =>
      parseSchedule({ schedule: "fixed_time", time: "09:00", weekdays: "Monday" }),
    ).toThrow("Weekdays");
    expect(parseSchedule({ schedule: "fixed_time", time: "09:00", weekdays: "" })).toEqual({
      type: "fixed_time",
      timeOfDay: "09:00",
    });
  });

  it("rejects intervals below the server minimum and impossible one-time dates", () => {
    expect(parseSchedule({ schedule: "interval", minutes: "1.5" })).toEqual({
      type: "interval",
      everyMs: 90_000,
    });
    for (const minutes of ["0", "-1", "Infinity", "NaN", ""])
      expect(() => parseSchedule({ schedule: "interval", minutes })).toThrow("one minute");
    expect(parseSchedule({ schedule: "once", runAt: "2026-12-01T09:00:00+01:00" })).toEqual({
      type: "once",
      runAt: "2026-12-01T09:00:00+01:00",
    });
    expect(() => parseSchedule({ schedule: "once", runAt: "2026-02-30T09:00:00+01:00" })).toThrow();
    expect(() => parseSchedule({ schedule: "once", runAt: "2026-12-01T09:00:00" })).toThrow(
      "offset",
    );
  });

  it("preserves existing webhook signature, deduplication and filters when editing ordinary fields", () => {
    const schedule = {
      type: "webhook" as const,
      signature: { header: "x-hub-signature-256", prefix: "sha256=", encoding: "hex" as const },
      maxDeliveryAgeMinutes: 30,
      filters: [{ path: "action", op: "equals" as const, value: "opened" }],
    };
    expect(parseSchedule({ schedule: "webhook" }, schedule)).toEqual(schedule);
    expect(parseSchedule({ schedule: "webhook" })).toEqual({ type: "webhook", signature: null });
  });
});
