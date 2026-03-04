'use client'

// ─── COMPONENT ────────────────────────────────────────────────────────────────
// Loads Adsterra inside an iframe pointing to /api/ad — an API route that
// serves the ad HTML with its own permissive CSP headers. This guarantees
// the ad script can use eval() and load images from any source, while
// the main page keeps its strict CSP untouched.
export default function AdBanner({ className = '' }: { className?: string }) {
  return (
    <div className={`overflow-hidden ${className}`} style={{ minHeight: 80 }}>
      <iframe
        src="/api/ad"
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
