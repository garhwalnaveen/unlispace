export function OrbitMark({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <ellipse cx="12" cy="12" rx="10" ry="5" transform="rotate(-35 12 12)" stroke="currentColor" strokeWidth="1.7" />
    <circle cx="12" cy="12" r="3.3" fill="currentColor" />
    <circle cx="20" cy="6" r="2" fill="currentColor" />
  </svg>;
}
