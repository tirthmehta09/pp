'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, ChevronDown, ChevronRight, AlertTriangle, Loader2, CheckCircle2, FileDown, Eye } from 'lucide-react';
import { Api } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatDate } from '@/lib/utils';
import { BatchDetail } from '../casting/issue/batch-detail';
import { cn } from '@/lib/utils';

/**
 * Batch Inventory — history of every batch, partitioned into three folders the
 * user can browse independently:
 *   1. Short-Closed (any stage was short-closed) — has a design-number search.
 *   2. Active        (in-process / pending stages, no shorts).
 *   3. Completed     (all stages fully received, no shorts).
 */
export default function BatchInventoryPage() {
  const [detailId, setDetailId] = React.useState<number | null>(null);
  const [globalSearch, setGlobalSearch] = React.useState('');
  const batchesQ = useQuery({
    queryKey: ['casting-batches'],
    queryFn: () => Api.casting.batches(),
  });

  const all = batchesQ.data ?? [];
  // Apply the top-level search first (filters every folder).
  const gq = globalSearch.trim().toLowerCase();
  const matchSearch = (b: any) =>
    !gq ||
    b.batchNumber.toLowerCase().includes(gq) ||
    (b.designNumbers || []).some((d: string) => String(d).toLowerCase().includes(gq)) ||
    (b.vendors || []).some((v: any) => (v.name || '').toLowerCase().includes(gq));

  // Folder classification uses the batch-level CLOSED flag — not per-stage shorts.
  // Short-Closed wins over status.
  const filtered = all.filter(matchSearch);
  const shortClosed = filtered.filter((b: any) => b.closed);
  const active = filtered.filter((b: any) => !b.closed && b.displayStatus !== 'Completed');
  const completed = filtered.filter((b: any) => !b.closed && b.displayStatus === 'Completed');

  return (
    <div>
      <PageHeader
        title="Batch Inventory"
        subtitle="Every batch ever issued, partitioned by lifecycle. Search filters across all folders; a batch goes to Short-Closed only when it's explicitly marked closed (not because individual stages were short)."
      />

      {/* Global search — applies to every folder below */}
      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search by design number, batch number, or vendor…" className="pl-8"
              value={globalSearch} onChange={(e) => setGlobalSearch(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {batchesQ.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground"><Spinner /> Loading…</div>
      ) : (
        <div className="space-y-4">
          <Folder
            title="Short-Closed"
            tone="red"
            icon={AlertTriangle}
            description="Batches explicitly closed short via Close Batch Short. Reopen from the batch detail to undo."
            batches={shortClosed}
            onOpen={(id) => setDetailId(id)}
          />
          <Folder
            title="Active"
            tone="amber"
            icon={Loader2}
            description="In-process and pending batches that still need attention."
            batches={active}
            onOpen={(id) => setDetailId(id)}
          />
          <Folder
            title="Completed"
            tone="emerald"
            icon={CheckCircle2}
            description="Fully received — every stage settled with no short close."
            batches={completed}
            onOpen={(id) => setDetailId(id)}
          />
        </div>
      )}

      <BatchDetail batchId={detailId} open={detailId != null} onClose={() => setDetailId(null)} />
    </div>
  );
}

function Folder({
  title, tone, icon: Icon, description, batches, onOpen,
}: {
  title: string;
  tone: 'red' | 'amber' | 'emerald';
  icon: any;
  description: string;
  batches: any[];
  onOpen: (id: number) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const rows = batches;

  const tones: Record<string, { ring: string; pill: string; head: string }> = {
    red:     { ring: 'border-red-200 bg-red-50/40',      pill: 'bg-red-100 text-red-800',      head: 'text-red-700' },
    amber:   { ring: 'border-amber-200 bg-amber-50/40',  pill: 'bg-amber-100 text-amber-800',  head: 'text-amber-700' },
    emerald: { ring: 'border-emerald-200 bg-emerald-50/30', pill: 'bg-emerald-100 text-emerald-800', head: 'text-emerald-700' },
  };
  const t = tones[tone];

  return (
    <Card className={cn('overflow-hidden', t.ring)}>
      <CardContent className="p-0">
        <button type="button" onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 border-b border-border bg-card px-4 py-3 text-left hover:bg-muted/30">
          <div className="flex items-center gap-3">
            {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
            <Icon className={cn('size-5', t.head)} />
            <div>
              <div className="text-sm font-semibold">{title}</div>
              <div className="text-xs text-muted-foreground">{description}</div>
            </div>
          </div>
          <span className={cn('rounded-full px-2.5 py-1 text-sm font-semibold', t.pill)}>{batches.length}</span>
        </button>

        {open && (
          <div className="p-3">
            {rows.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No {title.toLowerCase()} batches.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 text-left text-slate-600">
                    <tr>
                      <th className="px-3 py-2">Batch #</th>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Designs</th>
                      <th className="px-3 py-2">Pcs Ordered</th>
                      <th className="px-3 py-2">Processes</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((b: any) => (
                      <tr key={b.id} className="cursor-pointer border-t border-border hover:bg-muted/40" onClick={() => onOpen(b.id)}>
                        <td className="px-3 py-2 font-semibold">{b.batchNumber}</td>
                        <td className="px-3 py-2 text-muted-foreground">{formatDate(b.batchDate)}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1">
                            {(b.designNumbers || []).slice(0, 6).map((d: string) => (
                              <Badge key={d} variant="outline" className="text-xs">#{d}</Badge>
                            ))}
                            {(b.designNumbers?.length ?? 0) > 6 && (
                              <span className="text-xs text-muted-foreground">+{b.designNumbers.length - 6}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2">{b.piecesOrdered}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {(b.processNames || []).map((n: string) => (
                              <Badge key={n} variant="default" className="text-xs">{n}</Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', t.pill)}>{b.displayStatus}</span>
                          {b.openStages > 0 && (
                            <div className="mt-0.5 text-xs text-muted-foreground">{b.openStages} step(s) open</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); onOpen(b.id); }}>
                            <Eye className="size-4" /> Open
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
