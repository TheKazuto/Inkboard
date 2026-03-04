'use client'

// ─── COMPONENT ────────────────────────────────────────────────────────────────
// Loads Adsterra inside an iframe pointing to /ad.html which is served
// with its own permissive CSP (allows unsafe-eval that Adsterra needs).
// The main page keeps its strict CSP untouched.
export default function AdBanner({ className = '' }: { className?: string }) {
  return (
    <div className={`overflow-hidden ${className}`} style={{ minHeight: 80 }}>
      <iframe
        src="/ad.html"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          minHeight: 80,
          overflow: 'hidden',
        }}
        scrolling="no"
        loading="lazy"
      />
    </div>
  )
}
