import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Wrapper around <input> that:
 * - applies our theming + invalid-state styling
 * - DEFENSIVELY coerces an undefined `value` prop to '' when the input is
 *   controlled (i.e., `onChange` is also passed). This prevents the
 *   "uncontrolled → controlled" warning that fires when value starts undefined
 *   (e.g. from `obj?.field` evaluated before the data loads) and later
 *   becomes defined. Inputs without `onChange` (uncontrolled / defaultValue)
 *   are left alone.
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, value, onChange, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        value={value}
        onChange={onChange}
        className={cn(
          'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
