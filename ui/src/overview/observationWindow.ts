import { calendarDays } from "./buildTimeline";

/** Today and the preceding thirteen dates, using the dashboard's UTC calendar. */
export function observationDays(today: string): string[] {
  return calendarDays(new Date(`${today}T00:00:00Z`));
}

export function hasObservationDate(timestamp: string, days: readonly string[]): boolean {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) && days.includes(date.toISOString().slice(0, 10));
}
