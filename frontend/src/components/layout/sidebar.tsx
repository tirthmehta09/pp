'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  LayoutGrid,
  Truck,
  Gem,
  Boxes,
  ClipboardList,
  Package,
  PackageCheck,
  Receipt,
  Layers,
  Wallet,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const nav = [
  { section: 'Main' },
  { href: '/dashboard', label: 'Dashboard', icon: LayoutGrid },
  { section: 'Masters' },
  { href: '/vendors', label: 'Vendor Master', icon: Truck },
  { href: '/materials', label: 'Material Variants', icon: Gem },
  { href: '/inventory', label: 'Raw Materials Inventory', icon: Boxes },
  { href: '/items', label: 'Item Master', icon: Package },
  { href: '/casting/batches', label: 'Production Management', icon: Layers },
  { href: '/produced', label: 'Production Inventory', icon: PackageCheck },
  { href: '/material-issues', label: 'Material Issues', icon: Receipt },
  { href: '/batch-inventory', label: 'Batch Inventory', icon: ClipboardList },
  { href: '/vendor-ledger', label: 'Vendor Ledger', icon: Wallet },
  { section: 'Coming soon' },
  { href: '#', label: 'Production Orders', icon: ClipboardList, disabled: true },
  { href: '#', label: 'BOM & Costing', icon: Receipt, disabled: true },
];

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const search = useSearchParams();
  // Active rule: items whose href has a query string must match exactly (path + query);
  // others get the usual prefix match. Lets us route two sidebar entries (Production
  // Management vs Batch History) at the same path but different scopes.
  const isActive = (href: string) => {
    if (!href || href === '#') return false;
    const [path, query] = href.split('?');
    if (query) {
      const sp = new URLSearchParams(query);
      const wanted = Object.fromEntries(sp.entries());
      return pathname === path && Object.entries(wanted).every(([k, v]) => search.get(k) === v);
    }
    // No query in nav entry — match path but exclude links that DO want a specific scope.
    return pathname === href || (pathname.startsWith(href) && href !== pathname && !search.get('scope'));
  };

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/50 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-sidebar text-sidebar-foreground transition-transform duration-200 lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-white/10 px-4">
          <Link href="/dashboard" className="flex items-center gap-2.5 font-bold text-white">
            <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-sky-400 text-sm font-extrabold text-white">
              J
            </span>
            Jewellery ERP
          </Link>
          <button onClick={onClose} className="rounded p-1 text-white/70 hover:bg-white/10 lg:hidden">
            <X className="size-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-2">
          {nav.map((item, i) =>
            'section' in item ? (
              <div
                key={i}
                className="px-4 pb-1 pt-4 text-[0.66rem] font-bold uppercase tracking-wider text-slate-500"
              >
                {item.section}
              </div>
            ) : (
              <Link
                key={item.href + i}
                href={item.disabled ? '#' : item.href!}
                onClick={(e) => {
                  if (item.disabled) e.preventDefault();
                  else if (window.innerWidth < 1024) onClose();
                }}
                className={cn(
                  'mx-2 flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  item.disabled
                    ? 'cursor-not-allowed text-slate-500'
                    : isActive(item.href!)
                      ? 'bg-primary/20 text-white'
                      : 'text-slate-300 hover:bg-white/5 hover:text-white',
                )}
              >
                <item.icon className="size-[18px]" />
                {item.label}
              </Link>
            ),
          )}
        </nav>
      </aside>
    </>
  );
}
