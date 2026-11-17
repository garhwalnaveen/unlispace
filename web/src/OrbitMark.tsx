export function OrbitMark({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 28 28" fill="none" aria-hidden="true">
    <circle cx="14" cy="14" r="4.4" fill="currentColor" />
    <ellipse cx="14" cy="14" rx="12" ry="5" transform="rotate(-28 14 14)" stroke="currentColor" strokeWidth="1.7" />
  </svg>;
}
