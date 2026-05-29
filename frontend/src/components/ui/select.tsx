import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Lightweight native <select> styled to match the design system.
 * (Avoids extra Radix dependencies while keeping accessible semantics.)
 */
export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

// Defensively coerce undefined `value` to '' for controlled selects (mirrors
// the Input wrapper) — prevents the "uncontrolled → controlled" warning when
// value starts undefined before the data loads.
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, value, onChange, ...props }, ref) => {
    return (
      <div className="relative">
        <select
          ref={ref}
          value={value}
          onChange={onChange}
          className={cn(
            'flex h-9 w-full appearance-none rounded-md border border-input bg-card px-3 py-1 pr-8 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      </div>
    );
  },
);
Select.displayName = 'Select';

export { Select };
