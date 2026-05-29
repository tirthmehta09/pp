import * as React from 'react';
import { cn } from '@/lib/utils';

export type CheckboxProps = React.InputHTMLAttributes<HTMLInputElement>;

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, ...props }, ref) => (
    <input
      type="checkbox"
      ref={ref}
      className={cn(
        'size-4 rounded border-input text-primary shadow-sm focus:ring-2 focus:ring-ring focus:ring-offset-1 cursor-pointer accent-primary',
        className,
      )}
      {...props}
    />
  ),
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
