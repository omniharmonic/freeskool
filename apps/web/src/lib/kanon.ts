/**
 * k-anonymity display helper.
 *
 * Counts drawn from app-side tables (RSVPs, attendance, feedback) can identify
 * a person when they are small: "1 person said this class was hard" in a room
 * of three is not anonymous. Below the threshold we show a floor rather than a
 * number, and never a roster.
 *
 * Mirrors the aggregator in packages/shared; kept here so the shell can render
 * honestly before the AppView exists.
 */

export const K_THRESHOLD = 5;

export interface KAnonDisplay {
  /** Safe to show as an exact number. */
  exact: boolean;
  /** What to print. */
  label: string;
}

export function kAnonCount(count: number, noun: string, k: number = K_THRESHOLD): KAnonDisplay {
  if (!Number.isFinite(count) || count < 0) return { exact: false, label: `no ${noun} yet` };
  if (count === 0) return { exact: true, label: `no ${noun} yet` };
  if (count < k) return { exact: false, label: `fewer than ${k} ${noun}` };
  return { exact: true, label: `${count} ${count === 1 ? noun.replace(/s$/, '') : noun}` };
}

/**
 * Attendance and RSVP counts are shown exactly, because the person chose to be
 * counted and the count names nobody. Feedback aggregates are not.
 */
export function kAnonFeedback(count: number, k: number = K_THRESHOLD): string | null {
  if (count < k) return null;
  return `${count} people left notes`;
}
