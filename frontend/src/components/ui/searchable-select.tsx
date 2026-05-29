'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { ChevronsUpDown, Check, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SSOption {
  value: number | string;
  label: string;
  /** Optional muted second line (code / specs / stock) — for richer pickers. */
  subtitle?: string;
  /** Optional right-aligned chip (e.g., "320 pcs" stock). */
  meta?: string;
  /** Extra text to match the search against (codes etc.). */
  keywords?: string;
}

/**
 * Type-to-filter combobox with a clean two-line item layout. Renders the panel
 * via a portal so it never gets clipped by a parent dialog's overflow.
 */
export function SearchableSelect({
  value, onChange, options, placeholder = '— Select —', disabled, className, id,
}: {
  value: number | string | '' | null | undefined;
  onChange: (v: string) => void;
  options: SSOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [coords, setCoords] = React.useState<{ top: number; left: number; width: number; openUp: boolean; maxHeight: number } | null>(null);
  const [mounted, setMounted] = React.useState(false);

  const selected = options.find((o) => String(o.value) === String(value ?? ''));

  React.useEffect(() => { setMounted(true); }, []);

  const positionPanel = React.useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const margin = 12;
    const idealH = 360;
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    // Open in whichever direction has more room; cap maxHeight to fit that space.
    const openUp = spaceAbove > spaceBelow && spaceBelow < idealH;
    const maxHeight = Math.max(160, Math.min(idealH, openUp ? spaceAbove : spaceBelow));
    setCoords({
      top: openUp ? r.top - 6 : r.bottom + 6,
      left: r.left,
      width: r.width,
      openUp,
      maxHeight,
    });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    positionPanel();
    const onScroll = () => positionPanel();
    const onResize = () => positionPanel();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, positionPanel]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => `${o.label} ${o.subtitle ?? ''} ${o.meta ?? ''} ${o.keywords ?? ''}`.toLowerCase().includes(q))
    : options;

  return (
    <div className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button" id={id} disabled={disabled}
        onClick={() => { if (!disabled) { setOpen((o) => !o); setQuery(''); } }}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-sm transition-colors',
          'hover:border-foreground/30 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
          disabled && 'cursor-not-allowed opacity-50',
          !selected && 'text-muted-foreground',
        )}
      >
        <span className="truncate text-left">{selected ? selected.label : placeholder}</span>
        <ChevronsUpDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {mounted && open && coords && createPortal(
        <div
          ref={panelRef}
          className="z-[100] flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
          style={{
            position: 'fixed',
            top: coords.openUp ? undefined : coords.top,
            bottom: coords.openUp ? window.innerHeight - coords.top : undefined,
            left: coords.left,
            minWidth: coords.width,
            width: Math.max(coords.width, 360),
            maxWidth: Math.min(window.innerWidth - coords.left - 16, 520),
            maxHeight: coords.maxHeight,
          }}
        >
          <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
            <Search className="size-3.5 text-muted-foreground" />
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to search…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <span className="text-xs text-muted-foreground">{filtered.length}/{options.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">No matches.</div>
            )}
            {filtered.map((o) => {
              const isSel = String(o.value) === String(value ?? '');
              return (
                <button
                  type="button" key={String(o.value)}
                  onClick={() => { onChange(String(o.value)); setOpen(false); }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                    isSel ? 'bg-primary/10 font-medium text-foreground' : 'hover:bg-muted',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{o.label}</div>
                    {o.subtitle && (
                      <div className="truncate text-xs text-muted-foreground">{o.subtitle}</div>
                    )}
                  </div>
                  {o.meta && (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground/70">{o.meta}</span>
                  )}
                  {isSel && <Check className="size-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
