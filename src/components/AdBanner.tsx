'use client'

import { useEffect, useRef } from 'react'

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Adsterra ad unit script URL (provided by Adsterra dashboard)
const ADSTERRA_SRC =
  'https://pl28844904.effectivegatecpm.com/68/ce/1d/68ce1d5a90edc273336da9c93f8a8bef.js'

// ─── COMPONENT ────────────────────────────────────────────────────────────────
export default function AdBanner({ className = '' }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const loadedRef    = useRef(false)

  useEffect(() => {
    if (loadedRef.current || !containerRef.current) return
    loadedRef.current = true

    const script = document.createElement('script')
    script.src   = ADSTERRA_SRC
    script.async = true
    script.type  = 'text/javascript'

    containerRef.current.appendChild(script)

    return () => {
      // Cleanup on unmount — remove injected ad elements
      if (containerRef.current) {
        containerRef.current.innerHTML = ''
      }
      loadedRef.current = false
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={`overflow-hidden flex items-center justify-center ${className}`}
      style={{ minHeight: 80 }}
    />
  )
}
