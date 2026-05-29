'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Receipt, Truck, AlertTriangle, FileDown, ChevronDown, ChevronRight, Undo2 } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Field, SectionTitle } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatDate } from '@/lib/utils';
import type { Vendor, MaterialVariant } from '@/lib/types';

/**
 * Raw Material Issue & Return — voucher-based tracking of materials going to a
 * sticking karigar (or any vendor) and coming back. Mirrors the workflow:
 *   1. We issue 1000 stones (voucher created, stock -1000).
 *   2. They use 720, return 280 leftover (receipt qty 280, stock +280).
 *   3. If they short us — return less than expected — close shows the shortQty.
 */
export default function MaterialIssuesPage() {
  const qc = useQueryClient();
  const [openCreate, setOpenCreate] = React.useState(false);
  const [createKey, setCreateKey] = React.useState(0); // remount fresh per open
  const [viewId, setViewId] = React.useState<number | null>(null);

  // Refetch on focus + every 30s — receipts in the casting flow change "Used"
  // and "Pending" here, and the user shouldn't have to manually reload to see it.
  const issuesQ = useQuery({
    queryKey: ['material-issues'], queryFn: () => Api.materialIssues.list(),
    refetchOnWindowFocus: true, refetchInterval: 30_000,
  });
  const holdingsQ = useQuery({
    queryKey: ['vendor-holdings'], queryFn: () => Api.materialIssues.vendorHoldings(),
    refetchOnWindowFocus: true, refetchInterval: 30_000,
  });

  const issues = issuesQ.data ?? [];
  const holdings = holdingsQ.data ?? [];

  // Group holdings by vendor for display.
  const holdingsByVendor = React.useMemo(() => {
    const m = new Map<number, { vendorCode: string; vendorName: string; items: any[] }>();
    for (const h of holdings as any[]) {
      const v = m.get(h.vendorId) ?? { vendorCode: h.vendorCode, vendorName: h.vendorName, items: [] as any[] };
      v.items.push(h);
      m.set(h.vendorId, v);
    }
    return Array.from(m.entries()).map(([vendorId, v]) => ({ vendorId, ...v }));
  }, [holdings]);

  const openNew = () => { setCreateKey((k) => k + 1); setOpenCreate(true); };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['material-issues'] });
    qc.invalidateQueries({ queryKey: ['vendor-holdings'] });
    qc.invalidateQueries({ queryKey: ['variants'] });
  };

  return (
    <div>
      <PageHeader
        title="Material Issues"
        subtitle="Raw materials given to vendors (sticking karigars etc.) — track what's out, what came back, and any shorts."
        actions={<Button onClick={openNew}><Plus className="size-4" /> Issue to Vendor</Button>}
      />

      {/* Vendor Holdings — collapsible per vendor. Click a vendor row to expand
          a table of materials they're holding. Same pattern as Production
          Inventory cards: collapsed by default, click to open the details. */}
      <VendorHoldingsCard vendors={holdingsByVendor} />


      {/* Issue voucher list */}
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3 font-semibold">
            <Receipt className="size-4 text-primary" /> Issue Vouchers
          </div>
          {issuesQ.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground"><Spinner /> Loading…</div>
          ) : issues.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">No material issues yet. Click "Issue to Vendor" to create the first one.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-slate-600">
                  <tr>
                    <th className="px-4 py-2">Voucher</th>
                    <th className="px-4 py-2">Date</th>
                    <th className="px-4 py-2">Vendor</th>
                    <th className="px-4 py-2">Linked Batch</th>
                    <th className="px-4 py-2">Lines</th>
                    <th className="px-4 py-2 text-right">Issued</th>
                    <th className="px-4 py-2 text-right">Received</th>
                    <th className="px-4 py-2 text-right">Short</th>
                    <th className="px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((r: any) => (
                    <tr key={r.id} className="cursor-pointer border-t border-border hover:bg-muted/40" onClick={() => setViewId(r.id)}>
                      <td className="px-4 py-2 font-semibold text-primary">{r.voucherNumber}</td>
                      <td className="px-4 py-2 text-muted-foreground">{formatDate(r.issueDate)}</td>
                      <td className="px-4 py-2">{r.vendorCode} · {r.vendorName}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{r.batchNumber || '—'}</td>
                      <td className="px-4 py-2">{r.lineCount}</td>
                      <td className="px-4 py-2 text-right font-medium">{r.totalIssued}</td>
                      <td className="px-4 py-2 text-right font-medium text-emerald-700">{r.totalReceived}</td>
                      <td className="px-4 py-2 text-right font-medium text-amber-700">{r.totalShort || '—'}</td>
                      <td className="px-4 py-2"><StatusPill status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {openCreate && (
        <IssueDialog
          key={createKey}
          open={openCreate}
          onClose={() => setOpenCreate(false)}
          onDone={() => { setOpenCreate(false); refresh(); }}
        />
      )}
      {viewId != null && (
        <IssueDetailDialog
          id={viewId}
          open={viewId != null}
          onClose={() => setViewId(null)}
          onChange={refresh}
        />
      )}
    </div>
  );
}

/** Vendor holdings — one row per vendor, click to expand a tidy table of
 *  what they hold + a "Return Materials" action that records returns across
 *  every open voucher in one shot (FIFO by issue date). */
function VendorHoldingsCard({ vendors }: { vendors: { vendorId: number; vendorCode: string; vendorName: string; items: any[] }[] }) {
  const [open, setOpen] = React.useState<Record<number, boolean>>({});
  const [returnFor, setReturnFor] = React.useState<{ vendorId: number; vendorCode: string; vendorName: string; items: any[] } | null>(null);
  const toggle = (id: number) => setOpen((m) => ({ ...m, [id]: !m[id] }));
  const grandTotal = vendors.reduce((s, v) => s + v.items.reduce((ss, h: any) => ss + h.qty, 0), 0);

  return (
    <Card className="mb-4 border-sky-200">
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-sky-200 bg-sky-50 px-5 py-3">
          <Truck className="size-5 text-sky-600" />
          <span className="font-semibold text-sky-900">Vendor holdings — raw materials currently with vendors</span>
          <span className="ml-auto text-sm font-medium text-sky-700">
            {grandTotal} pcs across {vendors.length} vendor{vendors.length === 1 ? '' : 's'}
          </span>
        </div>
        {vendors.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No raw materials currently with any vendor — everything has been returned or consumed.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {vendors.map((v) => {
              const isOpen = !!open[v.vendorId];
              const totalQty = v.items.reduce((s, h: any) => s + h.qty, 0);
              return (
                <div key={v.vendorId}>
                  <div className="flex w-full items-center justify-between gap-3 px-5 py-3 hover:bg-muted/40">
                    <button type="button" onClick={() => toggle(v.vendorId)}
                      className="flex flex-1 items-center gap-3 text-left">
                      {isOpen ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                      <div>
                        <div className="text-sm font-semibold">{v.vendorCode} · {v.vendorName}</div>
                        <div className="text-xs text-muted-foreground">
                          {v.items.length} material{v.items.length === 1 ? '' : 's'} · {totalQty} pcs total
                        </div>
                      </div>
                    </button>
                    <Badge variant="info" className="font-semibold">{totalQty} pcs</Badge>
                    <Button size="sm" variant="outline"
                      onClick={(e) => { e.stopPropagation(); setReturnFor(v); }}>
                      <Undo2 className="size-3.5" /> Return Materials
                    </Button>
                  </div>
                  {isOpen && (
                    <div className="border-t border-border bg-muted/20 px-5 py-2">
                      <table className="w-full text-sm">
                        <thead className="text-left text-xs text-muted-foreground">
                          <tr>
                            <th className="px-2 py-1.5">Material</th>
                            <th className="px-2 py-1.5">Code</th>
                            <th className="px-2 py-1.5 text-right">Qty held</th>
                            <th className="px-2 py-1.5">Vouchers</th>
                          </tr>
                        </thead>
                        <tbody>
                          {v.items.map((h: any) => (
                            <tr key={h.variantId} className="border-t border-border/50">
                              <td className="px-2 py-1.5">
                                <div className="font-medium text-foreground">{h.variantName}</div>
                                {h.unit && <div className="text-xs text-muted-foreground">{h.unit}</div>}
                              </td>
                              <td className="px-2 py-1.5 font-mono text-xs text-muted-foreground">{h.variantCode}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-sky-700">{h.qty}</td>
                              <td className="px-2 py-1.5 text-xs text-muted-foreground">{(h.vouchers ?? []).join(', ') || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
      {returnFor && (
        <VendorReturnDialog
          vendor={returnFor}
          open={!!returnFor}
          onClose={() => setReturnFor(null)}
        />
      )}
    </Card>
  );
}

/** Record a return across all materials a vendor is holding (across vouchers).
 *  Per row the user types Return Qty; the live "After return" column shows what
 *  remains with the vendor, with a "Nullified" pill once a material hits zero. */
function VendorReturnDialog({
  vendor, open, onClose,
}: {
  vendor: { vendorId: number; vendorCode: string; vendorName: string; items: any[] };
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // variantId -> return qty (string for free typing).
  const [qty, setQty] = React.useState<Record<number, string>>({});

  React.useEffect(() => { if (open) setQty({}); }, [open, vendor.vendorId]);

  const setReturnQty = (variantId: number, qtyStr: string) =>
    setQty((m) => ({ ...m, [variantId]: qtyStr.replace(/[^0-9]/g, '') }));

  // Toggle: if every row is already filled with its max, clicking undoes
  // (clears all). Otherwise fills all to max. One button, two states.
  const allFilled = vendor.items.every((h: any) =>
    Math.max(0, Math.trunc(Number(qty[h.variantId] || 0))) === h.qty,
  );
  const toggleReturnAll = () => {
    if (allFilled) {
      setQty({});
      return;
    }
    const next: Record<number, string> = {};
    for (const h of vendor.items) next[h.variantId] = String(h.qty);
    setQty(next);
  };

  const submitting = React.useRef(false);
  const mutate = useMutation({
    mutationFn: () => {
      const items = vendor.items
        .map((h: any) => ({ variantId: h.variantId, returnedQty: Math.max(0, Math.trunc(Number(qty[h.variantId] || 0))) }))
        .filter((x) => x.returnedQty > 0);
      if (!items.length) throw new Error('Enter a return qty for at least one material.');
      // Defensive over-cap guard (server also enforces).
      for (const i of items) {
        const held = vendor.items.find((h: any) => h.variantId === i.variantId)?.qty ?? 0;
        if (i.returnedQty > held) throw new Error(`Cannot return ${i.returnedQty} — vendor only holds ${held}.`);
      }
      return Api.materialIssues.vendorReturn({ vendorId: vendor.vendorId, items });
    },
    onSuccess: (res) => {
      const total = (res.items ?? []).reduce((s, x) => s + x.returned, 0);
      toast.success(`Recorded ${total} pcs returned from ${vendor.vendorCode} — stock restored.`);
      qc.invalidateQueries({ queryKey: ['material-issues'] });
      qc.invalidateQueries({ queryKey: ['vendor-holdings'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
      qc.invalidateQueries({ queryKey: ['stock-movements'] });
      qc.invalidateQueries({ queryKey: ['variants'] });
      submitting.current = false;
      onClose();
    },
    onError: (e) => {
      submitting.current = false;
      toast.error(e instanceof Error && !(e as any).response ? e.message : getApiError(e).message);
    },
  });
  const submit = () => {
    if (submitting.current || mutate.isPending) return;
    submitting.current = true;
    mutate.mutate();
  };

  const totalReturning = vendor.items.reduce((s, h: any) =>
    s + Math.max(0, Math.trunc(Number(qty[h.variantId] || 0))), 0);

  // Live search across material name / code / unit — vendors with 20+ materials
  // are common and scrolling sucks. Empty search = show everything.
  const [search, setSearch] = React.useState('');
  const visibleItems = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return vendor.items;
    return vendor.items.filter((h: any) =>
      [h.variantName, h.variantCode, h.unit].some((x: any) => (x ?? '').toString().toLowerCase().includes(q)),
    );
  }, [vendor.items, search]);

  return (
    <Dialog open={open} onClose={onClose} size="lg"
      title={`Return Materials — ${vendor.vendorCode} · ${vendor.vendorName}`}
      description="Distributes returns across this vendor's open vouchers (FIFO by issue date)."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={mutate.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={mutate.isPending || totalReturning === 0}>
            {mutate.isPending && <Spinner />} {mutate.isPending ? 'Recording…' : `Record Return (${totalReturning} pcs)`}
          </Button>
        </>
      }>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Button type="button" size="sm"
            variant={allFilled ? 'default' : 'outline'}
            onClick={toggleReturnAll}>
            {allFilled ? 'Undo — clear all' : 'Return everything'}
          </Button>
          <div className="relative ml-auto min-w-[220px] flex-1">
            <Input
              placeholder="Search material name or code…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8"
            />
            <span className="absolute left-2.5 top-1.5 text-muted-foreground">🔍</span>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground">Tip: enter only what the vendor is physically handing back. Anything left stays "currently with vendor".</p>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Material</th>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2 text-right">Currently held</th>
                <th className="px-3 py-2 text-right">Return Now</th>
                <th className="px-3 py-2 text-right">After return</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No materials match "{search}".
                </td></tr>
              ) : visibleItems.map((h: any) => {
                const held = h.qty;
                const ret = Math.max(0, Math.trunc(Number(qty[h.variantId] || 0)));
                const remaining = Math.max(0, held - ret);
                const over = ret > held;
                const nullified = ret > 0 && remaining === 0;
                return (
                  <tr key={h.variantId} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground">{h.variantName}</div>
                      {h.unit && <div className="text-[10px] text-muted-foreground">{h.unit}</div>}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{h.variantCode}</td>
                    <td className="px-3 py-2 text-right font-semibold text-sky-700 tabular-nums">{held}</td>
                    <td className="px-3 py-2 text-right">
                      <Input type="number" min={0} max={held} step="1"
                        className={`h-8 w-24 text-right ${over ? 'border-red-300 bg-red-50' : ''}`}
                        value={qty[h.variantId] ?? ''}
                        onChange={(e) => setReturnQty(h.variantId, e.target.value)}
                        placeholder="0"
                      />
                      {over && <div className="text-[10px] text-red-600">exceeds held</div>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {ret === 0 ? (
                        <span className="text-muted-foreground tabular-nums">{held}</span>
                      ) : nullified ? (
                        <Badge variant="success">Nullified ✓</Badge>
                      ) : (
                        <span className="font-medium text-amber-700 tabular-nums">{remaining} still held</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Returns are applied FIFO across open vouchers. Stock is restored on save and each affected voucher's status recomputes (OPEN / PARTIAL / COMPLETED).
        </p>
      </div>
    </Dialog>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls: Record<string, string> = {
    OPEN: 'bg-amber-100 text-amber-800',
    PARTIAL: 'bg-sky-100 text-sky-800',
    COMPLETED: 'bg-emerald-100 text-emerald-800',
    CLOSED: 'bg-slate-200 text-slate-700',
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls[status] ?? 'bg-slate-100 text-slate-700'}`}>{status}</span>;
}

/** Create a new material-issue voucher (manual flow). */
function IssueDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [lines, setLines] = React.useState<{ variantId: number | ''; issuedQty: string; notes: string }[]>([
    { variantId: '', issuedQty: '', notes: '' },
  ]);
  const [notes, setNotes] = React.useState('');

  // Raw materials are issued to STICKING vendors — restrict the dropdown to them.
  const processesQ = useQuery({ queryKey: ['processes'], queryFn: () => Api.processes() });
  const stickingId = (processesQ.data ?? []).find((p: any) => p.code === 'STICKING')?.id;
  const vendorsQ = useQuery<Vendor[]>({
    queryKey: ['sticking-vendors', stickingId],
    queryFn: () => Api.vendors.list({ status: 'ACTIVE', processId: stickingId }),
    enabled: !!stickingId,
  });
  const variantsQ = useQuery<MaterialVariant[]>({ queryKey: ['variants'], queryFn: () => Api.materials.variants({ status: 'ACTIVE' }) });

  const variantOf = (id: any) => (variantsQ.data ?? []).find((v) => v.id === Number(id));

  const setLine = (i: number, patch: any) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { variantId: '', issuedQty: '', notes: '' }]);
  const removeLine = (i: number) => setLines((ls) => ls.filter((_, k) => k !== i));

  // "Order more" — record an IN stock movement so the issue can proceed without the shortage warning.
  const qc = useQueryClient();
  const orderMore = useMutation({
    mutationFn: (args: { variantId: number; qty: number; name: string }) =>
      Api.materials.adjustStock(args.variantId, { type: 'IN', quantity: args.qty, note: `Ordered for issue voucher (${args.name})` }),
    onSuccess: (_, args) => {
      toast.success(`Stock +${args.qty} recorded for ${args.name}.`);
      qc.invalidateQueries({ queryKey: ['variants'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const create = useMutation({
    mutationFn: () => {
      if (!vendorId) throw new Error('Choose a vendor.');
      const valid = lines.filter((l) => l.variantId && Number(l.issuedQty) > 0);
      if (!valid.length) throw new Error('Add at least one material with a quantity.');
      for (const l of valid) {
        const q = Number(l.issuedQty);
        if (!Number.isInteger(q)) throw new Error('Quantities must be whole numbers.');
      }
      return Api.materialIssues.create({
        vendorId: Number(vendorId), notes: notes || undefined,
        lines: valid.map((l) => ({ variantId: Number(l.variantId), issuedQty: Number(l.issuedQty), notes: l.notes || undefined })),
      });
    },
    onSuccess: (r: any) => { toast.success(`Voucher ${r.voucherNumber} created.`); onDone(); },
    onError: (e) => toast.error(e instanceof Error && !(e as any).response ? e.message : getApiError(e).message),
  });

  // Stock-shortage warning per line.
  const shortLines = lines
    .map((l, i) => ({ i, line: l, variant: variantOf(l.variantId) }))
    .filter((x) => x.variant && Number(x.line.issuedQty || 0) > Math.trunc(Number(x.variant.stockQty)))
    .map((x) => ({ ...x, stock: Math.trunc(Number(x.variant!.stockQty)) }));

  return (
    <Dialog open={open} onClose={onClose} size="xl"
      title="Issue Raw Materials to Vendor"
      description="Stock is deducted immediately on save. Record returns from the voucher detail."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending && <Spinner />} Create Voucher
          </Button>
        </>
      }>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Vendor" required>
            <SearchableSelect
              value={vendorId}
              placeholder="— Select vendor —"
              onChange={(v) => setVendorId(v ? Number(v) : '')}
              options={(vendorsQ.data ?? []).map((v) => ({ value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName }))}
            />
          </Field>
          <Field label="Notes (optional)"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. For order #6633 Rajwadi" /></Field>
        </div>

        <div>
          <SectionTitle>Materials to Issue</SectionTitle>
          <div className="space-y-2">
            {lines.map((l, i) => {
              const variant = variantOf(l.variantId);
              const stock = variant ? Math.trunc(Number(variant.stockQty)) : 0;
              const qty = Number(l.issuedQty || 0);
              const short = variant && qty > stock;
              return (
                <div key={i} className="rounded-lg border border-border bg-muted/30 p-3">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                    <div className="sm:col-span-5">
                      <Field label="Material">
                        <SearchableSelect
                          value={l.variantId}
                          placeholder="— Select material —"
                          onChange={(val) => setLine(i, { variantId: val ? Number(val) : '' })}
                          options={(variantsQ.data ?? []).map((v) => {
                            const st = Math.trunc(Number(v.stockQty));
                            const specs = [v.size, v.color].filter(Boolean).join(' · ');
                            return {
                              value: v.id,
                              label: v.variantName,
                              subtitle: `${v.variantCode}${specs ? ` · ${specs}` : ''}`,
                              meta: `stock ${st}`,
                              keywords: `${v.variantCode} ${v.materialName ?? ''}`,
                            };
                          })}
                        />
                      </Field>
                    </div>
                    <div className="sm:col-span-2">
                      <Field label="Issued Qty" hint="whole number">
                        <Input type="number" step="1" min="0" value={l.issuedQty}
                          onChange={(e) => setLine(i, { issuedQty: e.target.value.replace(/[^0-9]/g, '') })} />
                      </Field>
                    </div>
                    <div className="sm:col-span-2">
                      <Field label="In Stock">
                        <div className={`flex h-9 items-center rounded-md border px-2.5 text-sm ${short ? 'border-red-300 bg-red-50 text-red-700' : 'border-border bg-card text-muted-foreground'}`}>
                          {variant ? `${stock}${variant.unit ? ' ' + variant.unit : ''}` : '—'}
                        </div>
                      </Field>
                    </div>
                    <div className="sm:col-span-2">
                      <Field label="Notes"><Input value={l.notes} onChange={(e) => setLine(i, { notes: e.target.value })} /></Field>
                    </div>
                    <div className="flex items-end sm:col-span-1">
                      <Button type="button" variant="outline" size="icon" className="mb-0.5 text-destructive hover:bg-destructive/10" onClick={() => removeLine(i)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                  {short && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50/60 px-2.5 py-1.5 text-xs text-red-800">
                      <span className="flex items-center gap-2">
                        <AlertTriangle className="size-3.5" />
                        Need <strong>{qty}</strong> but only <strong>{stock}</strong> in stock —
                        short by <strong>{qty - stock}</strong>.
                      </span>
                      <Button type="button" size="sm" variant="outline"
                        className="h-7 border-red-300 bg-white text-red-700 hover:bg-red-100"
                        disabled={orderMore.isPending}
                        onClick={() => {
                          if (window.confirm(`Order ${qty - stock} more of ${variant!.variantName}? This adds them to stock now (record the purchase).`)) {
                            orderMore.mutate({ variantId: variant!.id, qty: qty - stock, name: variant!.variantName });
                          }
                        }}>
                        <Plus className="size-3" /> Order {qty - stock} more
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={addLine}>
            <Plus className="size-4" /> Add Material
          </Button>
        </div>

        {shortLines.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <strong>Stock shortage:</strong> {shortLines.length} line{shortLines.length === 1 ? '' : 's'} exceed available stock. Use the <em>Order more</em> button on each row to record the purchase before issuing, or reduce the qty.
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** View a voucher's lines + record return + close. */
function IssueDetailDialog({ id, open, onClose, onChange }: { id: number; open: boolean; onClose: () => void; onChange: () => void }) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['material-issue', id], queryFn: () => Api.materialIssues.get(id), enabled: open,
    // Auto-refresh while the dialog is open so "Used" reflects the latest
    // sticking receipts without the user closing + reopening the voucher.
    refetchOnWindowFocus: true, refetchInterval: open ? 20_000 : false,
  });
  const [ret, setRet] = React.useState<Record<number, string>>({}); // lineId -> qty

  React.useEffect(() => { setRet({}); }, [id]);

  const setRetLine = (lineId: number, qty: string) =>
    setRet((m) => ({ ...m, [lineId]: qty.replace(/[^0-9]/g, '') }));

  const recordReturn = useMutation({
    mutationFn: () => {
      const lines = Object.entries(ret)
        .filter(([, q]) => Number(q) > 0)
        .map(([lineId, q]) => ({ lineId: Number(lineId), returnedQty: Number(q) }));
      if (!lines.length) throw new Error('Enter a return qty for at least one line.');
      return Api.materialIssues.recordReturn(id, { lines });
    },
    onSuccess: () => { toast.success('Return recorded — stock restored.'); refetch(); onChange(); setRet({}); },
    onError: (e) => toast.error(e instanceof Error && !(e as any).response ? e.message : getApiError(e).message),
  });

  const close = useMutation({
    mutationFn: () => {
      const reason = window.prompt('Close this voucher? Anything still pending is recorded as short.\n\nReason (optional):', '');
      if (reason === null) throw new Error('Cancelled.');
      return Api.materialIssues.close(id, { reason: reason || undefined });
    },
    onSuccess: () => { toast.success('Voucher closed.'); refetch(); onChange(); },
    onError: (e) => toast.error(e instanceof Error && !(e as any).response ? e.message : getApiError(e).message),
  });

  if (!data && isLoading) {
    return <Dialog open={open} onClose={onClose} size="md" title="Loading…"><div className="flex justify-center py-10"><Spinner /></div></Dialog>;
  }
  if (!data) return null;

  const totalPending = data.lines.reduce((s: number, l: any) => s + l.pendingQty, 0);

  return (
    <Dialog open={open} onClose={onClose} size="lg"
      title={`Voucher ${data.voucherNumber}`}
      description={`${data.vendor.vendorCode} · ${data.vendor.vendorName} · ${formatDate(data.issueDate)}${data.batchNumber ? ` · linked to batch ${data.batchNumber}` : ''}`}
      footer={
        <>
          <a href={Api.materialIssues.issuePdfUrl(data.id)} target="_blank" rel="noreferrer">
            <Button variant="outline" type="button"><FileDown className="size-4" /> Issue Slip</Button>
          </a>
          <a href={Api.materialIssues.returnPdfUrl(data.id)} target="_blank" rel="noreferrer">
            <Button variant="outline" type="button"><FileDown className="size-4" /> Status / Return Slip</Button>
          </a>
          <Button variant="outline" onClick={onClose}>Close</Button>
          {data.status !== 'CLOSED' && totalPending > 0 && (
            <Button onClick={() => recordReturn.mutate()} disabled={recordReturn.isPending}>
              {recordReturn.isPending && <Spinner />} Record Return
            </Button>
          )}
          {data.status !== 'CLOSED' && (
            <Button variant="outline" onClick={() => close.mutate()} disabled={close.isPending} className="text-amber-700 hover:bg-amber-50">
              {close.isPending && <Spinner />} Close Short
            </Button>
          )}
        </>
      }>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm">
          <StatusPill status={data.status} />
          <span className="text-muted-foreground">·</span>
          <span>{data.lines.length} material line(s)</span>
          {totalPending > 0 && <><span className="text-muted-foreground">·</span><span className="text-amber-700">{totalPending} pcs still pending return</span></>}
        </div>

        {data.usage && (
          <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
            <div className="font-semibold">Used for production:</div>
            <div className="mt-1">
              Batch <strong>{data.usage.batchNumber}</strong> · {data.usage.processName}
              {' · '}Design <strong>#{data.usage.itemNumber ?? '—'}</strong> ({data.usage.designCode})
              {data.usage.color && <> · Colour <strong>{data.usage.color}</strong></>}
              {' · '}<strong>{data.usage.stageQty}</strong> pcs being produced
              {' · '}<strong>{data.usage.stickingReceived ?? 0}</strong> pcs received back so far
            </div>
            <div className="mt-1 text-xs text-sky-700">
              "Used" only counts BOM consumption for sticking pieces actually returned. The rest of the issued qty is sitting with the vendor.
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-slate-600">
              <tr>
                <th className="px-3 py-2">Material</th>
                <th className="px-3 py-2 text-right">Issued</th>
                <th className="px-3 py-2 text-right" title="Materials consumed = BOM-per-piece × sticking pcs received back. Until pieces come back, this is 0.">Used</th>
                <th className="px-3 py-2 text-right">Returned</th>
                <th className="px-3 py-2 text-right">Pending</th>
                {data.status !== 'CLOSED' && <th className="px-3 py-2 text-right">Return Now</th>}
                <th className="px-3 py-2 text-right">Short</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l: any) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="font-medium">{l.variantName}</div>
                    <div className="text-xs text-muted-foreground">{l.variantCode}</div>
                  </td>
                  <td className="px-3 py-2 text-right font-medium">{l.issuedQty}</td>
                  <td className="px-3 py-2 text-right text-sky-700">{l.usedQty}</td>
                  <td className="px-3 py-2 text-right text-emerald-700">{l.receivedQty}</td>
                  <td className="px-3 py-2 text-right text-amber-700">{l.pendingQty}</td>
                  {data.status !== 'CLOSED' && (
                    <td className="px-3 py-2 text-right">
                      <Input
                        type="number" min="0" step="1" className="h-8 w-24 text-right"
                        value={ret[l.id] ?? ''}
                        onChange={(e) => setRetLine(l.id, e.target.value)}
                        placeholder="0"
                        disabled={l.pendingQty === 0 && l.receivedQty + (l.usedQty ?? 0) >= l.issuedQty}
                      />
                    </td>
                  )}
                  <td className="px-3 py-2 text-right text-red-700">{l.shortQty ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {data.notes && (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
            <div className="text-xs font-semibold uppercase text-muted-foreground">Notes</div>
            <p>{data.notes}</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
