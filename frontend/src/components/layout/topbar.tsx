'use client';

import * as React from 'react';
import { Menu, LogOut, ChevronDown, UserCircle2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = React.useState(false);

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-card px-4">
      <button
        onClick={onMenu}
        className="rounded-md p-2 text-muted-foreground hover:bg-accent lg:hidden"
      >
        <Menu className="size-5" />
      </button>

      <div className="ml-auto relative">
        <button
          onClick={() => setOpen((o) => !o)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-accent"
        >
          <UserCircle2 className="size-5 text-muted-foreground" />
          <span className="hidden sm:inline font-medium">{user?.fullName ?? 'User'}</span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </button>
        {open && (
          <div className="absolute right-0 mt-1 w-48 rounded-md border border-border bg-card py-1 shadow-lg">
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Signed in as <span className="font-semibold text-foreground">{user?.username}</span>
            </div>
            <div className="my-1 border-t border-border" />
            <button
              onMouseDown={logout}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-accent"
            >
              <LogOut className="size-4" /> Logout
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
