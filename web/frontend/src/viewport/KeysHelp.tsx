import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'

/** The 3D view's keys, Blender's, grouped as the popup lists them. */
function sections(): { title: string; keys: [string, string][] }[] {
  return [
    {
      title: t('keys.selectShow'),
      keys: [
        ['Click', t('keys.click')],
        ['Shift / Ctrl + click', t('keys.shiftClick')],
        ['A', t('keys.a')],
        ['Alt + A', t('keys.altA')],
        ['H', t('keys.h')],
        ['Shift + H', t('keys.shiftH')],
        ['Alt + H', t('keys.altH')],
        ['Z', t('keys.z')],
        ['Shift + Z', t('keys.shiftZ')],
      ],
    },
    {
      title: t('keys.moveRotate'),
      keys: [
        ['G', t('keys.g')],
        ['R', t('keys.r')],
        ['Shift + D', t('keys.shiftD')],
        ['X / Del', t('keys.xDel')],
        ['X / Y / Z', t('keys.xyz')],
        ['G  X  10', t('keys.gx')],
        ['R  Z  90', t('keys.rz')],
        ['Ctrl', t('keys.ctrl')],
        ['Enter / click', t('keys.enter')],
        ['Esc / right-click', t('keys.esc')],
      ],
    },
    {
      title: t('keys.view'),
      keys: [
        ['1 / 3 / 7', t('keys.137')],
        ['5', t('keys.5')],
        ['2 4 6 8', t('keys.2468')],
        ['9', t('keys.9')],
        ['F / Home / .', t('keys.fit')],
        ['C', t('keys.c')],
        ['Left drag', t('keys.drag')],
        ['Alt + left drag / right drag', t('keys.rightDrag')],
        ['Ctrl / Meta + left drag / middle drag', t('keys.mouseZoom')],
        ['Wheel', t('keys.wheel')],
      ],
    },
  ]
}

function KeyboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="4.5" width="15" height="9.5" rx="1.5" />
      <path d="M4.5 7.5h1M7.5 7.5h1M10.5 7.5h1M13 7.5h.5M4.5 10h1M13 10h.5M7 11.2h4" strokeLinecap="round" />
    </svg>
  )
}

/** A keyboard button, floating beside the view toolbar, that shows the 3D view's keys. */
export function KeysHelp() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <span className="keys-help" ref={ref}>
      <button
        className={open ? 'on' : undefined}
        onClick={() => setOpen(!open)}
        title={t('keys.title')}
        aria-label={t('keys.title')}
        aria-expanded={open}
      >
        <KeyboardIcon />
      </button>
      {open && (
        <div className="keys-popup" role="dialog" aria-label={t('keys.title')}>
          {sections().map((s) => (
            <section key={s.title}>
              <h4>{s.title}</h4>
              <dl>
                {s.keys.map(([k, what]) => (
                  <div key={k}>
                    <dt>
                      {/* Keys as keycaps; ' / ', ' + ' and a double space (a sequence) between them. */}
                      {k.split(/(\s\/\s|\s\+\s|\s{2})/).map((part, i) =>
                        i % 2 ? <span key={i}>{part.trim() || ' '}</span> : <kbd key={i}>{part}</kbd>,
                      )}
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </span>
  )
}
