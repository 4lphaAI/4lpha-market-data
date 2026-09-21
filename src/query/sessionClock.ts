/**
 * The NYSE session clock, ported from the execution plane's `isUsEquityOpen`
 * (`D:\4lpha-execution\src\trade\universe.ts`) as a pure function of one
 * instant. `America/New_York`, Mon–Fri 09:30–16:00 regular trading hours
 * (RTH), 16:00–20:00 the after-hours "close" window, everything else —
 * weekends included — `overnight`. **No holiday calendar**: on Good Friday
 * this clock says `rth` while NYSE is shut. `SESSION_CLOCK.holidays` says so
 * on every payload; a consumer that needs the calendar checks the reference's
 * own `openState`.
 *
 * DST is taken from the ICU zone data through `Intl.DateTimeFormat`, so the
 * 09:30 ET boundary lands on 13:30 UTC in summer and 14:30 UTC in winter
 * without a rule table here. The transitions themselves happen at 02:00 ET,
 * never inside a boundary this module converts.
 */

export const SESSION_CLOCK = {
  timeZone: "America/New_York",
  rth: "09:30-16:00",
  close: "16:00-20:00",
  holidays: "none",
} as const;

export type SessionState = "rth" | "close" | "overnight";

const RTH_OPEN = { hour: 9, minute: 30 } as const;
const RTH_CLOSE = { hour: 16, minute: 0 } as const;
const AFTER_HOURS_END = { hour: 20, minute: 0 } as const;
export const ORB_WINDOW_MS = 30 * 60_000;

const FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: SESSION_CLOCK.timeZone, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface EtParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }
interface EtDate { year: number; month: number; day: number }

/** Wall-clock parts of `ms` in New York. */
export function etParts(ms: number): EtParts {
  const parts = FORMAT.formatToParts(new Date(ms));
  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "NaN");
  const weekday = WEEKDAYS.indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
  const out = { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute"), second: read("second"), weekday };
  if (weekday < 0 || Object.values(out).some((n) => !Number.isFinite(n))) throw new Error("session clock: zone data unavailable");
  return out;
}

function etOffsetMs(ms: number): number {
  const p = etParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of an ET wall time. Boundaries never fall inside a DST gap. */
export function etToUtc(date: EtDate, hour: number, minute: number): number {
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const first = guess - etOffsetMs(guess);
  const offset = etOffsetMs(first);
  return offset === etOffsetMs(guess) ? first : guess - offset;
}

function addDays(date: EtDate, days: number): EtDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
function weekdayOf(date: EtDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}
function isTradingDay(date: EtDate): boolean {
  const w = weekdayOf(date);
  return w >= 1 && w <= 5;
}

export interface Session {
  state: SessionState;
  /** When `state` next changes. */
  nextBoundaryAt: number;
  /** Start of the bucket run `vwapSession` sums over: RTH open, 16:00 ET, or the most recent 20:00 ET. */
  sessionStart: number;
  /** The current RTH day's 09:30 / 16:00 ET; only meaningful while `state === "rth"`. */
  rthStart: number;
  rthEnd: number;
  /** Most recent weekday 16:00 ET at or before the instant, and that day's 09:30. */
  lastRthCloseAt: number;
  lastRthOpenAt: number;
  /** The opening-range window [09:30, 10:00) ET of the current RTH day. */
  orbStart: number;
  orbEnd: number;
}

/** Everything the session-anchored metrics need about one instant. */
export function sessionAt(ms: number): Session {
  if (!Number.isFinite(ms)) throw new Error("session clock: invalid instant");
  const today = etParts(ms);
  const date: EtDate = { year: today.year, month: today.month, day: today.day };
  const rthStart = etToUtc(date, RTH_OPEN.hour, RTH_OPEN.minute);
  const rthEnd = etToUtc(date, RTH_CLOSE.hour, RTH_CLOSE.minute);
  const afterHoursEnd = etToUtc(date, AFTER_HOURS_END.hour, AFTER_HOURS_END.minute);
  const tradingDay = isTradingDay(date);

  let state: SessionState, nextBoundaryAt: number, sessionStart: number;
  if (tradingDay && ms >= rthStart && ms < rthEnd) {
    state = "rth"; nextBoundaryAt = rthEnd; sessionStart = rthStart;
  } else if (tradingDay && ms >= rthEnd && ms < afterHoursEnd) {
    state = "close"; nextBoundaryAt = afterHoursEnd; sessionStart = rthEnd;
  } else {
    state = "overnight";
    // Most recent 20:00 ET at or before the instant, whatever the weekday.
    sessionStart = ms >= afterHoursEnd ? afterHoursEnd : etToUtc(addDays(date, -1), AFTER_HOURS_END.hour, AFTER_HOURS_END.minute);
    let next = date;
    if (!(tradingDay && ms < rthStart)) {
      next = addDays(date, 1);
      while (!isTradingDay(next)) next = addDays(next, 1);
    }
    nextBoundaryAt = etToUtc(next, RTH_OPEN.hour, RTH_OPEN.minute);
  }

  let last = date;
  for (let i = 0; i < 8; i++) {
    if (isTradingDay(last) && etToUtc(last, RTH_CLOSE.hour, RTH_CLOSE.minute) <= ms) break;
    last = addDays(last, -1);
  }
  return {
    state, nextBoundaryAt, sessionStart, rthStart, rthEnd,
    lastRthCloseAt: etToUtc(last, RTH_CLOSE.hour, RTH_CLOSE.minute),
    lastRthOpenAt: etToUtc(last, RTH_OPEN.hour, RTH_OPEN.minute),
    orbStart: rthStart, orbEnd: rthStart + ORB_WINDOW_MS,
  };
}
