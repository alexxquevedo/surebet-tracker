'use client'
import { useEffect, useState } from 'react'

/** Observa la clase `dark` en <html> y devuelve true cuando está activa. */
export function useDarkMode(): boolean {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const check = () => setDark(document.documentElement.classList.contains('dark'))
    check()
    const obs = new MutationObserver(check)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}
