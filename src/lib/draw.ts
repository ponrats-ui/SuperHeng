/**
 * Draw schedule helpers.
 *
 * The countdown must always point at a future draw, so instead of hard-coding a
 * timestamp we compute the next occurrence of a recurring weekly schedule.
 */

export type DrawSchedule = {
  /** Human label, e.g. "Grand Weekly Draw". */
  title: string;
  /** Days of week the draw runs (0 = Sunday ... 6 = Saturday). */
  days: number[];
  /** Local hour (0-23). */
  hour: number;
  /** Local minute (0-59). */
  minute: number;
  /** IANA-ish timezone label shown in the UI. */
  timezone: string;
};

export const DRAW_SCHEDULE: DrawSchedule = {
  title: 'Grand Weekly Draw',
  days: [0, 3, 6], // Sun, Wed, Sat
  hour: 18,
  minute: 30,
  timezone: 'Your local time',
};

/** Returns the next scheduled draw instant strictly after `from`. */
export function getNextDrawAt(from: Date = new Date(), schedule: DrawSchedule = DRAW_SCHEDULE): Date {
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(from);
    candidate.setDate(from.getDate() + offset);
    candidate.setHours(schedule.hour, schedule.minute, 0, 0);
    if (schedule.days.includes(candidate.getDay()) && candidate.getTime() > from.getTime()) {
      return candidate;
    }
  }
  // Fallback: exactly one week out (schedule with no matching day).
  const fallback = new Date(from);
  fallback.setDate(from.getDate() + 7);
  return fallback;
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
