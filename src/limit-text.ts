/*
 * Usage-limit lines Claude Code writes into a transcript when a quota blocks
 * the session. Best-effort: only the phrases observed in public transcripts
 * count. The text is classified and discarded; it is never stored.
 *
 * Counted (first line, after trim):
 *   /^You've hit your (?:session|weekly) limit\b/
 *   /^You've hit your org's monthly spend limit\b/
 * Not counted, even with error "rate_limit" (transient API throttle):
 *   /not your usage limit/i
 *   /temporarily limiting requests/i
 * Reset clock, same line, no date in the log:
 *   /\bresets (\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i
 * Without a date, wait is the next time-of-day in that timezone. That
 * underestimates a weekly or monthly reset. An unknown timezone omits wait.
 */

export const USAGE_LIMIT_RE =
  /^You've hit your (?:session|weekly) limit\b|^You've hit your org's monthly spend limit\b/;

export const TRANSIENT_LIMIT_RE =
  /not your usage limit|temporarily limiting requests/i;

export const RESET_CLOCK_RE =
  /\bresets (\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i;

export type LimitHit = {
  at: number;
  /** Rounded hours until the stated reset. Null when the line has no clock. */
  waitHours: number | null;
};

type Zoned = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function zonedParts(instant: Date, timeZone: string): Zoned | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant);
    const pick = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value);
    const hour = pick("hour");
    return {
      year: pick("year"),
      month: pick("month"),
      day: pick("day"),
      hour: hour === 24 ? 0 : hour,
      minute: pick("minute"),
      second: pick("second"),
    };
  } catch {
    return null;
  }
}

function isIana(timeZone: string): boolean {
  return zonedParts(new Date(0), timeZone) != null;
}

function offsetAt(utcMs: number, timeZone: string): number | null {
  const parts = zonedParts(new Date(utcMs), timeZone);
  if (!parts) return null;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - utcMs;
}

/** UTC milliseconds of a wall-clock time in `timeZone`, or null in a DST gap. */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetAt(utcGuess, timeZone);
  if (first == null) return null;
  const second = offsetAt(utcGuess - first, timeZone);
  if (second == null) return null;
  const utc = utcGuess - second;
  const parts = zonedParts(new Date(utc), timeZone);
  if (
    !parts ||
    parts.year !== year ||
    parts.month !== month ||
    parts.day !== day ||
    parts.hour !== hour ||
    parts.minute !== minute
  ) {
    return null;
  }
  return utc;
}

/**
 * Hours from `eventMs` until the next `h:mm am/pm` in `timeZone`.
 * Returns null when the zone is missing or not a real IANA name.
 */
export function waitHoursUntil(
  eventMs: number,
  hour12: number,
  minute: number,
  ampm: string,
  timeZone: string | null,
): number | null {
  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null;
  const zone = timeZone?.trim() ?? "";
  if (!zone || !isIana(zone)) return null;
  let hour = hour12 % 12;
  if (ampm.toLowerCase() === "pm") hour += 12;
  const start = zonedParts(new Date(eventMs), zone);
  if (!start) return null;
  for (let add = 0; add < 8; add++) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + add));
    const target = zonedToUtc(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      hour,
      minute,
      zone,
    );
    if (target == null || target + 30_000 < eventMs) continue;
    const hours = Math.round((target - eventMs) / 3_600_000);
    if (hours < 0 || hours > 168) return null;
    return hours;
  }
  return null;
}

/** Classifies one limit message. The caller must drop `text` afterwards. */
export function classifyUsageLimit(text: string, at: number): LimitHit | null {
  if (!Number.isFinite(at)) return null;
  const first = text.trim().split("\n", 1)[0]?.trim() ?? "";
  if (!first || TRANSIENT_LIMIT_RE.test(first) || !USAGE_LIMIT_RE.test(first)) {
    return null;
  }
  const reset = RESET_CLOCK_RE.exec(first);
  const waitHours = reset
    ? waitHoursUntil(
        at,
        Number(reset[1]),
        reset[2] ? Number(reset[2]) : 0,
        reset[3] ?? "",
        reset[4] ?? null,
      )
    : null;
  return { at, waitHours };
}
