'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, PackageCheck, Factory, Truck, ChevronDown, ChevronRight } from 'lucide-react';
import { Api } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/**
 * Inventory — ONE CARD PER DESIGN. At a glance:
 *   - Big total at the header (how many of this design exist anywhere).
 *   - Three coloured stat tiles: Finished / In-House / At Vendor.
 *   - Lots grouped by BATCH, each row one line you can read in plain English:
 *       "10 pcs · Ruby · with V0008 · Sticky (Sticking)".
 */
export default function InventoryPage() {
  const [search, setSearch] = React.useState('');
  const { data, isLoading } = useQuery({ queryKey: ['produced'], queryFn: () => Api.casting.produced() });

  const allRows = data?.rows ?? [];
  const byDesign = data?.byDesign ?? [];
  const q = search.trim().toLowerCase();

  const designMatches = (d: any) =>
    !q || [d.designCode, d.itemName, String(d.itemNumber ?? '')].some((x: any) => (x ?? '').toString().toLowerCase().includes(q));
  const lotMatches = (r: any) =>
    !q || [r.processName, r.vendorName, r.color, ...(r.batches || [])].some((x: any) => (x ?? '').toString().toLowerCase().includes(q));

  // Group lots by design + by batch within each design.
  const lotsByDesignAndBatch = React.useMemo(() => {
    const m = new Map<number, Map<string, any[]>>(); // itemId → batchNumber → lots[]
    for (const r of allRows) {
      const batchKey = (r.batches || ['—']).join(', ');
      const designMap = m.get(r.itemId) ?? new Map<string, any[]>();
      const arr = designMap.get(batchKey) ?? [];
      arr.push(r);
      designMap.set(batchKey, arr);
      m.set(r.itemId, designMap);
    }
    return m;
  }, [allRows]);

  // Apply search at both levels — keep a design if either it or any of its lots matches.
  const visibleDesigns = byDesign.filter((d: any) => {
    if (designMatches(d)) return true;
    const lots = lotsByDesignAndBatch.get(d.itemId);
    if (!lots) return false;
    for (const arr of lots.values()) if (arr.some(lotMatches)) return true;
    return false;
  });

  const grandFinished = byDesign.reduce((s: number, d: any) => s + d.finishedQty, 0);
  const grandInHouse  = byDesign.reduce((s: number, d: any) => s + d.inHouseQty, 0);
  const grandAtVendor = byDesign.reduce((s: number, d: any) => s + d.atVendorQty, 0);

  return (
    <div>
      <PageHeader
        title="Production Inventory"
        subtitle="Every piece of every design — where it is right now, in plain English."
      />

      {/* Search + grand totals */}
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="relative min-w-[260px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search design / item no. / batch / vendor / colour…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <StatPill icon={PackageCheck} colour="emerald" label="Finished" value={grandFinished} />
          <StatPill icon={Factory} colour="amber" label="In-House" value={grandInHouse} />
          <StatPill icon={Truck} colour="sky" label="At Vendor" value={grandAtVendor} />
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground"><Spinner /> Loading…</div>
      ) : visibleDesigns.length === 0 ? (
        <Card><CardContent className="px-5 py-10 text-center text-muted-foreground">No produced stock anywhere.</CardContent></Card>
      ) : (
        <div className="space-y-4">
          {visibleDesigns.map((d: any) => (
            <DesignCard
              key={d.itemId}
              design={d}
              lotsByBatch={lotsByDesignAndBatch.get(d.itemId) ?? new Map()}
              search={q}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StatPill({ icon: Icon, colour, label, value }: { icon: any; colour: 'emerald'|'amber'|'sky'; label: string; value: number }) {
  const cls: Record<string,string> = {
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber:   'bg-amber-50 text-amber-700 border-amber-200',
    sky:     'bg-sky-50 text-sky-700 border-sky-200',
  };
  return (
    <div className={cn('flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium', cls[colour])}>
      <Icon className="size-4" />
      <span>{label}</span>
      <span className="font-bold">{value}</span>
      <span className="text-xs opacity-70">pcs</span>
    </div>
  );
}

/** One card = one design, everything about it in one place. */
function DesignCard({ design, lotsByBatch, search }: { design: any; lotsByBatch: Map<string, any[]>; search: string }) {
  const [open, setOpen] = React.useState(false);
  const batches = Array.from(lotsByBatch.entries()).sort(); // sort batches by name

  return (
    <Card>
      <CardContent className="p-0">
        {/* Header */}
        <button type="button" onClick={() => setOpen(!open)}
          className="flex w-full flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-5 py-3 text-left hover:bg-muted/50">
          <div className="flex items-center gap-3">
            {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
            <div>
              <div className="text-base font-semibold">
                #{design.itemNumber ?? '—'} · {design.designCode}
                {design.itemName && <span className="ml-2 text-sm font-normal text-muted-foreground">— {design.itemName}</span>}
              </div>
              <div className="text-xs text-muted-foreground">{batches.length} batch{batches.length === 1 ? '' : 'es'} contributing</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {design.finishedQty > 0 && <Badge variant="success" className="font-semibold">✓ {design.finishedQty} packed</Badge>}
            {design.inHouseQty > 0 && <Badge variant="warning" className="font-semibold">🏭 {design.inHouseQty} in-house</Badge>}
            {design.atVendorQty > 0 && <Badge variant="info" className="font-semibold">🚚 {design.atVendorQty} at vendor</Badge>}
            <Badge variant="outline" className="text-base font-bold">Total {design.totalQty}</Badge>
          </div>
        </button>

        {open && (
          <div className="divide-y divide-border">
            {batches.map(([batchKey, lots]) => (
              <BatchBlock key={batchKey} batch={batchKey} lots={lots} search={search} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Inside a design card: one row per batch, listing every lot in plain English. */
function BatchBlock({ batch, lots, search }: { batch: string; lots: any[]; search: string }) {
  const finished = lots.filter((l) => l.state === 'FINISHED');
  const inHouse  = lots.filter((l) => l.state === 'IN_HOUSE');
  const atVendor = lots.filter((l) => l.state === 'AT_VENDOR');
  const sum = (arr: any[]) => arr.reduce((s, l) => s + l.qty, 0);

  return (
    <div className="px-5 py-3">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <span className="font-semibold text-foreground">Batch {batch}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{sum(lots)} pcs across {lots.length} lot(s)</span>
      </div>
      <div className="space-y-1">
        {finished.map((l, i) => <LotLine key={`f${i}`} lot={l} search={search} />)}
        {inHouse.map((l, i) => <LotLine key={`h${i}`} lot={l} search={search} />)}
        {atVendor.map((l, i) => <LotLine key={`v${i}`} lot={l} search={search} />)}
      </div>
    </div>
  );
}

/** One plain-English row: "12 pcs · Ruby · Sticking · with V0008 Sticky Solutions". */
function LotLine({ lot, search }: { lot: any; search: string }) {
  const q = search.trim().toLowerCase();
  const hidden = q && ![lot.processName, lot.vendorName, lot.color, ...(lot.batches || [])]
    .some((x: any) => (x ?? '').toString().toLowerCase().includes(q));
  if (hidden && q) return null;

  // When the parent batch is short-closed, override the active-process labels —
  // these pieces aren't "ready for X", they're frozen in their last-touched state.
  const baseCls = {
    FINISHED: { bar: 'bg-emerald-500', label: 'Packed & ready', tone: 'text-emerald-700' },
    IN_HOUSE: { bar: 'bg-amber-500',   label: `In stock · ready for ${lot.nextProcessName || 'next step'}`, tone: 'text-amber-700' },
    AT_VENDOR:{ bar: 'bg-sky-500',     label: 'Currently with vendor', tone: 'text-sky-700' },
  }[lot.state as 'FINISHED'|'IN_HOUSE'|'AT_VENDOR'];

  const closedCls = {
    FINISHED: { bar: 'bg-slate-500', label: 'Packed (from short-closed batch)', tone: 'text-slate-700' },
    IN_HOUSE: { bar: 'bg-slate-500', label: 'Frozen at this step · batch short-closed', tone: 'text-slate-700' },
    AT_VENDOR:{ bar: 'bg-slate-500', label: 'With vendor · batch short-closed', tone: 'text-slate-700' },
  }[lot.state as 'FINISHED'|'IN_HOUSE'|'AT_VENDOR'];
  const cls = lot.batchClosed ? closedCls : baseCls;

  // Action links per lot — surface "reopen" and "forward" actions inline so
  // the user doesn't have to hunt for the batch in Production Management.
  // Closed-batch lots get a reopen link (Batch Inventory has the toggle);
  // in-house lots get a forward link (deep-links into the active batch).
  const batchLink = lot.batches && lot.batches[0]
    ? `/casting/batches?focus=${encodeURIComponent(lot.batches[0])}`
    : '/casting/batches';
  return (
    <div className={cn('flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2 text-sm', lot.batchClosed ? 'border-slate-300 bg-slate-50/60' : 'border-border')}>
      <span className={cn('inline-block size-1.5 shrink-0 rounded-full', cls.bar)} />
      <span className={cn('text-lg font-bold', lot.batchClosed ? 'text-slate-700' : 'text-foreground')}>{lot.qty}</span>
      <span className="text-xs text-muted-foreground">pcs</span>
      <span className="text-muted-foreground">·</span>
      <Badge variant="default">{lot.processName}</Badge>
      {lot.color && <Badge variant="outline">{lot.color}</Badge>}
      {lot.batchClosed && <Badge variant="destructive" className="text-[10px]">SHORT-CLOSED</Badge>}
      <span className="text-muted-foreground">·</span>
      {lot.state === 'FINISHED' ? (
        <span className={cn('text-sm font-medium', cls.tone)}>{cls.label}</span>
      ) : (
        <>
          <span className={cn('text-sm font-medium', cls.tone)}>{cls.label}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-sm">
            {lot.state === 'AT_VENDOR' ? 'with ' : 'last sent to '}
            <strong>{lot.vendorCode}</strong> {lot.vendorName}
          </span>
        </>
      )}
      {/* Action links — deep-link to the right page based on lot state. */}
      <span className="ml-auto flex items-center gap-2">
        {lot.batchClosed ? (
          <a href="/batch-inventory" className="text-xs font-medium text-primary hover:underline">
            Reopen batch →
          </a>
        ) : lot.state === 'IN_HOUSE' && lot.nextProcessName ? (
          <a href={batchLink} className="text-xs font-medium text-primary hover:underline">
            Forward to {lot.nextProcessName} →
          </a>
        ) : lot.state === 'AT_VENDOR' ? (
          <a href="/casting/receipt" className="text-xs font-medium text-primary hover:underline">
            Receive →
          </a>
        ) : null}
      </span>
    </div>
  );
}
