import { useEffect, useMemo, useRef, useState } from 'react';
import Search from 'lucide-react/dist/esm/icons/search';
import { useNavigate } from 'react-router';

const destinations = [
  ['/', 'Today', 'Continue the next study block'],
  ['/library', 'Library', 'Import, scan, and transcribe lectures'],
  ['/plan', 'Plan builder', 'Shape a realistic study week'],
  ['/ai', 'AI Studio', 'Models, jobs, artifacts, and provenance'],
  ['/study', 'Study Hub', 'Review and correct learning material'],
  ['/search', 'Search', 'Find an exact evidence moment'],
  ['/settings', 'Settings', 'AI, privacy, models, and updates'],
  ['/diagnostics', 'Diagnostics', 'Inspect local service health'],
] as const;

export function CommandPalette() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === 'Escape') setOpen(false);
    };
    const openPalette = () => setOpen(true);
    window.addEventListener('keydown', keydown);
    window.addEventListener('lectorbit:command-palette', openPalette);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('lectorbit:command-palette', openPalette);
    };
  }, []);
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
    else setQuery('');
  }, [open]);
  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term
      ? destinations.filter(([, label, detail]) =>
          `${label} ${detail}`.toLocaleLowerCase().includes(term),
        )
      : destinations;
  }, [query]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[80] flex justify-center bg-black/45 p-4 pt-[12vh]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) setOpen(false);
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="h-fit w-full max-w-xl overflow-hidden rounded-2xl border bg-card shadow-2xl"
      >
        <label className="flex items-center gap-3 border-b px-4">
          <Search className="size-5 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Go to a page or search your library…"
            className="h-14 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
        <div className="max-h-[55vh] overflow-y-auto p-2">
          {visible.map(([to, label, detail]) => (
            <button
              key={to}
              type="button"
              onClick={() => {
                setOpen(false);
                void navigate(to);
              }}
              className="flex w-full items-start justify-between gap-4 rounded-xl px-3 py-3 text-left hover:bg-accent"
            >
              <span>
                <span className="block text-sm font-semibold">{label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">{to}</span>
            </button>
          ))}
          {visible.length === 0 ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void navigate(`/search?q=${encodeURIComponent(query.trim())}`);
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-4 text-left hover:bg-accent"
            >
              <Search className="size-4 text-primary" />
              <span className="text-sm">Search the library for “{query.trim()}”</span>
            </button>
          ) : null}
        </div>
        <footer className="border-t px-4 py-2 text-[10px] text-muted-foreground">
          Ctrl K to toggle · Escape to close
        </footer>
      </section>
    </div>
  );
}
