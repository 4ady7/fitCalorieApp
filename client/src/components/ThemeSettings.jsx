import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { THEMES, readTheme, saveTheme } from '../theme.js';

export function ThemeSettings() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function choose(id) {
    setTheme(saveTheme(id));
  }

  return (
    <>
      <button
        type="button"
        className="ghost settings-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="settings-mark" aria-hidden="true" />
        Settings
      </button>
      {open && createPortal(
        <div className="backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className="dialog theme-dialog" role="dialog" aria-modal="true" aria-labelledby="theme-title">
            <header className="dialog-head">
              <div>
                <p className="eyebrow">For your eyes</p>
                <h2 id="theme-title">Appearance</h2>
              </div>
              <button type="button" className="ghost" onClick={() => setOpen(false)}>Close</button>
            </header>
            <p className="lede">The layout stays the same. Pick the colors that are easiest to read, and the page updates as you try them.</p>
            <div className="theme-list" role="radiogroup" aria-label="Color style">
              {THEMES.map((item) => {
                const selected = item.id === theme;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className="theme-option"
                    onClick={() => choose(item.id)}
                  >
                    <span className="theme-swatches" aria-hidden="true">
                      {item.swatches.map((color) => (
                        <span key={color} style={{ background: color }} />
                      ))}
                    </span>
                    <span className="theme-copy">
                      <strong>{item.name}</strong>
                      <span>{item.description}</span>
                    </span>
                    {selected && <span className="theme-current">In use</span>}
                  </button>
                );
              })}
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
