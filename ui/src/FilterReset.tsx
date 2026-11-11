export function FilterReset({ onReset }: { onReset: () => void }) {
  return <button type="button" className="filter-reset" onClick={onReset}>Reset filters</button>;
}

export function FilterScope({ label, onClear }: { label: string; onClear: () => void }) {
  return <button type="button" className="filter-scope" onClick={onClear} aria-label={`Clear ${label}`}>{label} <span aria-hidden="true">×</span></button>;
}
