'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Self-contained modal dialog (no external deps).
 * Layout: fixed overlay + flex column panel with a scrollable body and a
 * sticky header/footer so long forms always scroll and the actions stay visible.
 */
interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'md' | 'lg' | 'xl' | 'full';
}

const sizes = {
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
  full: 'max-w-[95vw]',
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'lg',
}: DialogProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-6">
      <div
        className="fixed inset-0"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative z-10 my-4 flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-xl border border-border bg-card shadow-2xl',
          sizes[size],
        )}
      >
        {/* Header (sticky) */}
        <div className="flex items-start justify-between gap-4 border-b border-border bg-muted/40 px-5 py-4">
          <div>
            {title && <h2 className="text-base font-semibold text-foreground">{title}</h2>}
            {description && (
              <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>

        {/* Footer (sticky) */}
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/40 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
