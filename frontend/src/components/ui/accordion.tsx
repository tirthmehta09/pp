'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AccordionItemProps {
  title: React.ReactNode;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function AccordionItem({ title, badge, defaultOpen, children }: AccordionItemProps) {
  const [open, setOpen] = React.useState(!!defaultOpen);
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold transition-colors',
          open ? 'bg-accent text-accent-foreground' : 'bg-card hover:bg-muted/60',
        )}
      >
        <span className="flex items-center gap-2">{title}</span>
        <span className="flex items-center gap-2">
          {badge}
          <ChevronDown
            className={cn('size-4 transition-transform', open && 'rotate-180')}
          />
        </span>
      </button>
      {open && <div className="border-t border-border bg-card px-4 py-4">{children}</div>}
    </div>
  );
}

export function Accordion({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('space-y-2', className)}>{children}</div>;
}
