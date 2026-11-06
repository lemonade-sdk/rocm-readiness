import { useEffect, useState } from "react";

export function useUtcToday(now?: Date): string {
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10));
  useEffect(() => {
    if (now) return;
    const timer = window.setInterval(() => setToday(new Date().toISOString().slice(0, 10)), 60_000);
    return () => window.clearInterval(timer);
  }, [now]);
  return now ? now.toISOString().slice(0, 10) : today;
}
