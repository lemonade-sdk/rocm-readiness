/** Calendar grouping and timestamp display always use UTC, independent of the browser zone. */
export function calendarDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(new Date(value));
}

export function producedAt(value: string): string {
  return `${new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", year: "numeric", hour: "2-digit",
    minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "UTC",
  }).format(new Date(value))} UTC`;
}
