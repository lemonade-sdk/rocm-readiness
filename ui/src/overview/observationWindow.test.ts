import { expect, it } from "vitest";
import { hasObservationDate, observationDays } from "./observationWindow";

it("includes today and thirteen preceding UTC dates", () => {
  const days = observationDays("2026-11-02");
  expect(days).toHaveLength(14);
  expect(days[0]).toBe("2026-10-20");
  expect(days.at(-1)).toBe("2026-11-02");
  expect(hasObservationDate("2026-10-20T00:00:00Z", days)).toBe(true);
  expect(hasObservationDate("2026-10-19T23:59:59Z", days)).toBe(false);
  expect(hasObservationDate("2026-11-03T00:00:00Z", days)).toBe(false);
  expect(hasObservationDate("invalid", days)).toBe(false);
  expect(hasObservationDate("2026-10-19T23:30:00-01:00", days)).toBe(true);
});
