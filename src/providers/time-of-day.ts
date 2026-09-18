/**
 * Opening hours, as a time of day rather than a moment in history.
 *
 * Postgres stores these columns as `time`, which has no date attached.
 * Prisma has no type for that, so it hands back a Date pinned to the first of
 * January 1970 — and JSON turns that into "1970-01-01T08:00:00.000Z", which
 * is what a customer was shown where "8:00 AM" belonged.
 *
 * The API therefore publishes "HH:MM", which is also the shape it accepts
 * when the hours are set, so what comes out can be sent straight back in.
 * Read in UTC on purpose: the stored value is a wall-clock time, and reading
 * it in the server's local zone would shift it by the offset.
 */

export type TimeOfDay = string | null;

/** A Date from a `time` column, as "HH:MM". */
export function toTimeOfDay(value: Date | string | null): TimeOfDay {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    // Already "HH:MM" or "HH:MM:SS" — from the cache, or from a caller.
    if (/^\d{2}:\d{2}/.test(value)) return value.slice(0, 5);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? null
      : parsed.toISOString().slice(11, 16);
  }
  return value.toISOString().slice(11, 16);
}

/** The inverse: "HH:MM" as the Date a `time` column expects. */
export function fromTimeOfDay(value: string): Date {
  return new Date(`1970-01-01T${value}:00Z`);
}

interface RawSlot {
  startTime: Date | string | null;
  endTime: Date | string | null;
}

/** One week of hours, with both ends converted. */
export function withTimesOfDay<T extends RawSlot>(
  slots: T[],
): (Omit<T, 'startTime' | 'endTime'> & {
  startTime: TimeOfDay;
  endTime: TimeOfDay;
})[] {
  return slots.map((slot) => ({
    ...slot,
    startTime: toTimeOfDay(slot.startTime),
    endTime: toTimeOfDay(slot.endTime),
  }));
}
