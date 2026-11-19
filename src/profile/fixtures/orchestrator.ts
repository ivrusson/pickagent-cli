import { measured, PROFILE_SCHEMA_ID, type Profile } from "../profile";

/*
 * Test fixture only. Invented numbers in the shape of a measured profile,
 * not anyone's data. Other personas from the private repo stay there.
 */

/** 24 hourly weights from `[fromHour, toHour, weight]` spans (wraps midnight). */
function hoursOf(...spans: [number, number, number][]): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const [from, to, weight] of spans) {
    for (let h = from; h !== to; h = (h + 1) % 24) hours[h] += weight;
  }
  return hours;
}

const WEEKDAYS_ONLY = [10, 10, 10, 10, 10, 0, 0];

/** Three agents in parallel during office hours. */
export const orchestrator: Profile = {
  schema: PROFILE_SCHEMA_ID,
  period: "2026-10",
  plans: ["claude-pro"],
  provenance: { "claude-code": "measured" },
  agent_hours: measured(142, "claude-code"),
  activity: measured(
    { hours: hoursOf([9, 14, 30], [15, 19, 20]), weekdays: WEEKDAYS_ONLY },
    "claude-code",
  ),
  by_model: measured(
    { "claude-sonnet": 0.71, "claude-opus": 0.29 },
    "claude-code",
  ),
  tokens: measured(
    [
      {
        model: "claude-opus",
        input: 2_470_000,
        output: 620_000,
        cache_read: 61_800_000,
        cache_write: 4_940_000,
      },
      {
        model: "claude-sonnet",
        input: 6_050_000,
        output: 1_510_000,
        cache_read: 151_200_000,
        cache_write: 12_100_000,
      },
    ],
    "claude-code",
  ),
  active_days: measured(21, "claude-code"),
  parallel_agents_p50: measured(3, "claude-code"),
  peak_window_load: measured(13, "claude-code"),
  sessions: measured({ count: 160, median_minutes: 45 }, "claude-code"),
  daily_variation: measured(0.4, "claude-code"),
  models_count: measured(2, "claude-code"),
};
