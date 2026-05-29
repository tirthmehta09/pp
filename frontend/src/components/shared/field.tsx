import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** Form field wrapper: label + control + inline error message. */
export function Field({
  label,
  required,
  error,
  hint,
  children,
  className,
}: {
  label?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('w-full', className)}>
      {label && <Label required={required}>{label}</Label>}
      {children}
      {hint && !error && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="mt-1 text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 mt-1 flex items-center gap-2 border-b border-accent pb-1.5 text-sm font-semibold text-primary">
      {children}
    </h3>
  );
}
