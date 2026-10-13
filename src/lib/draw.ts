/**
 * Draw schedule helpers.
 *
 * The countdown must always point at a future draw, so instead of hard-coding a
 * timestamp we compute the next occurrence of the recurring monthly schedule.
 */

export type DrawSchedule = {
  /** Human label, e.g. "Government Lottery Draw". */
  title: string;
  /** Days of the month the draw runs (1-based), e.g. the 1st and the 16th. */
  daysOfMonth: number[];
  /** Local hour (0-23). */
  hour: number;
  /** Local minute (0-59). */
  minute: number;
  /** IANA-ish timezone label shown in the UI. */
  timezone: string;
};

/**
 * Thai Government Lottery (GLO) cadence: two draws a month, on the **1st and the
 * 16th**, with the result announced in the late afternoon.
 *
 * This replaced an earlier placeholder that claimed a weekly Sun/Wed/Sat draw.
 * Verified against GLO's own API: draws exist for 2024-03-01 and 2024-03-16,
 * while non-draw dates answer `{"response": null}`.
 */
export const DRAW_SCHEDULE: DrawSchedule = {
  title: 'Government Lottery Draw',
  daysOfMonth: [1, 16],
  hour: 16,
  minute: 0,
  timezone: 'Your local time',
};

/** Returns the next scheduled draw instant strictly after `from`. */
export function getNextDrawAt(from: Date = new Date(), schedule: DrawSchedule = DRAW_SCHEDULE): Date {
  // Scan day by day; `new Date(y, m, d + offset)` rolls the month over for us, so
  // month boundaries and short months need no special casing.
  const horizonDays = 62; // two months is enough to find a hit for any monthly schedule
  for (let offset = 0; offset <= horizonDays; offset++) {
    const candidate = new Date(
      from.getFullYear(),
      from.getMonth(),
      from.getDate() + offset,
      schedule.hour,
      schedule.minute,
      0,
      0
    );
    if (
      schedule.daysOfMonth.includes(candidate.getDate()) &&
      candidate.getTime() > from.getTime()
    ) {
      return candidate;
    }
  }
  // Fallback: the next 1st of the month, so the countdown always has a target.
  return new Date(from.getFullYear(), from.getMonth() + 1, 1, schedule.hour, schedule.minute, 0, 0);
}

export type Countdown = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  totalSeconds: number;
};

/** Splits the remaining time until `target` into clock units. */
export function getCountdown(target: Date, from: Date = new Date()): Countdown {
  const totalSeconds = Math.max(0, Math.floor((target.getTime() - from.getTime()) / 1000));
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    totalSeconds,
  };
}

/** Zero-pads a clock unit to two digits. */
export function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}
