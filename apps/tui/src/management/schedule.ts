import { ScheduledTaskUpsertSchedule, type ScheduledTaskSchedule } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeSchedule = Schema.decodeSync(ScheduledTaskUpsertSchedule);

export function scheduleDescription(schedule: ScheduledTaskSchedule, timeZone?: string) {
  switch (schedule.type) {
    case "interval":
      return `Every ${schedule.everyMs / 60_000} minutes`;
    case "fixed_time":
      return `${schedule.timeOfDay}${timeZone ? ` (${timeZone})` : ""}${schedule.weekdays?.length ? ` · ${schedule.weekdays.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ")}` : " · every day"}`;
    case "once":
      return `Once at ${schedule.runAt}`;
    case "webhook":
      return "When a webhook arrives";
  }
}

export function parseSchedule(
  values: Record<string, string>,
  existing?: ScheduledTaskSchedule,
): ScheduledTaskUpsertSchedule {
  switch (values.schedule) {
    case "interval": {
      const minutes = Number(values.minutes);
      if (!Number.isFinite(minutes) || minutes < 1 || !Number.isSafeInteger(minutes * 60_000))
        throw new Error("The interval must be at least one minute.");
      return { type: "interval", everyMs: minutes * 60_000 };
    }
    case "fixed_time": {
      const timeOfDay = values.time ?? "";
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay))
        throw new Error("Enter a time as HH:MM, using the environment's time zone.");
      const input = values.weekdays?.trim() ?? "";
      const weekdays = input ? [...new Set(input.split(",").map((day) => Number(day.trim())))] : [];
      if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
        throw new Error(
          "Weekdays must be numbers from 0 (Sunday) to 6 (Saturday), separated by commas.",
        );
      return { type: "fixed_time", timeOfDay, ...(weekdays.length ? { weekdays } : {}) };
    }
    case "once": {
      const runAt = values.runAt ?? "";
      if (!/(Z|[+-]\d{2}:\d{2})$/.test(runAt) || !Number.isFinite(Date.parse(runAt)))
        throw new Error(
          "Enter an ISO date and time including an offset, such as 2026-12-01T09:00:00+01:00.",
        );
      return decodeSchedule({ type: "once", runAt });
    }
    case "webhook":
      return existing?.type === "webhook" ? existing : { type: "webhook", signature: null };
    default:
      throw new Error("Choose when this task should run.");
  }
}
