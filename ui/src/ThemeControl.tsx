import { useEffect, useRef, useState } from "react";

type Theme = "system" | "light" | "dark";
const storageKey = "rocm-readiness-theme";
function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(storageKey);
    if (value === "light" || value === "dark") return value;
  } catch {
    // The device preference remains usable when storage is blocked.
  }
  return "system";
}

export function ThemeControl() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [darkSystem, setDarkSystem] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dark = theme === "system" ? darkSystem : theme === "dark";

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const changed = (event: MediaQueryListEvent) =>
      setDarkSystem(event.matches);
    setDarkSystem(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  function choose(value: Theme) {
    setTheme(value);
    try {
      if (value === "system") localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, value);
    } catch {
      // An explicit choice still applies for this visit.
    }
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div className="theme-control" ref={container}>
      <button
        className="theme-toggle"
        type="button"
        ref={trigger}
        aria-label="Change color theme"
        title={`Theme: ${theme[0].toUpperCase() + theme.slice(1)} (${dark ? "Dark" : "Light"})`}
        aria-expanded={open}
        aria-controls={open ? "theme-options" : undefined}
        onClick={() => setOpen(!open)}
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          aria-hidden="true"
        >
          {dark ? (
            <path d="M20.5 14A8.7 8.7 0 0 1 10 3.5 8.7 8.7 0 1 0 20.5 14Z" />
          ) : (
            <>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
            </>
          )}
        </svg>
      </button>
      {open && (
        <div
          className="theme-options"
          id="theme-options"
          role="group"
          aria-label="Color theme"
        >
          {(["system", "light", "dark"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={theme === value}
              onClick={() => choose(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
