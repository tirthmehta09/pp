'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wallet, ArrowUpRight, ArrowDownLeft, AlertTriangle, Clock } from 'lucide-react';
import { Api } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { formatCurrency, formatDate } from '@/lib/utils';

const monthStart = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);
const wt = (g: number) => (g ? `${g.toFixed(3)} g` : '—');

// Shared column set for Issued / Received / Pending.
const UNIFIED_HEADERS = ['Date', 'Batch', 'Process', 'Item #', 'Vendor Ref', 'Qty', 'Total Wt', 'Recd', 'Pending', 'Amount'];

/** Pending cell: red when short (still owed), green "+n" when excess, grey when closed. */
function pendingCell(ordered: number, recd: number, closed: boolean, override?: number) {
  if (closed) return <span className="text-slate-500">closed</span>;
  const diff = override !== undefined ? override : ordered - recd;
  if (diff > 0) return <span className="font-medium text-red-600">{diff}</span>;
  if (diff < 0) return <span className="font-medium text-emerald-600">+{-diff}</span>;
  return <span className="text-muted-foreground">0</span>;
}

export default function VendorLedgerPage() {
  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [from, setFrom] = React.useState(monthStart());
  const [to, setTo] = React.useState(today());

  const vendorsQ = useQuery({ queryKey: ['vendors-all'], queryFn: () => Api.vendors.list() });
  const ledgerQ = useQuery({
    queryKey: ['vendor-ledger', vendorId, from, to],
    queryFn: () => Api.casting.vendorLedger(Number(vendorId), from, to),
    enabled: !!vendorId,
  });
  const d = ledgerQ.data;

  return (
    <div>
      <PageHeader
        title="Vendor Ledger"
        subtitle="Balances & bills — everything issued to and received from a vendor, plus outstanding short-closed balances."
      />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-[240px] flex-1">
            <label className="mb-1 block text-sm font-medium text-foreground/80">Vendor</label>
            <SearchableSelect
              value={vendorId}
              placeholder="— Select vendor —"
              onChange={(v) => setVendorId(v ? Number(v) : '')}
              options={(vendorsQ.data ?? []).map((v: any) => ({ value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground/80">From</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground/80">To</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {!vendorId ? (
        <Card><CardContent className="p-4"><EmptyState icon={Wallet} title="Select a vendor" description="Pick a vendor to see their transactions and balances for the period." /></CardContent></Card>
      ) : ledgerQ.isLoading || !d ? (
        <div className="flex justify-center py-16"><Spinner className="size-6 text-primary" /></div>
      ) : (
        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard icon={ArrowUpRight} color="bg-primary/10 text-primary" label="Issued"
              lines={[`${d.summary.issued.qty} pcs`, wt(d.summary.issued.weight), formatCurrency(d.summary.issued.amount)]} />
            <SummaryCard icon={ArrowDownLeft} color="bg-emerald-100 text-emerald-600" label="Received"
              lines={[`${d.summary.received.qty} pcs`, wt(d.summary.received.weight)]} />
            <SummaryCard icon={Clock} color="bg-amber-100 text-amber-600" label="Under Process (with vendor)"
              lines={[`${d.summary.underProcess?.qty ?? 0} pcs`, wt(d.summary.underProcess?.weight ?? 0)]} />
            <SummaryCard icon={AlertTriangle} color="bg-red-100 text-red-600" label="Outstanding (short-closed)"
              lines={[`${d.summary.outstanding.qty} pcs`, wt(d.summary.outstanding.weight), formatCurrency(d.summary.outstanding.amount)]} />
          </div>

          {/* 1) Issued — colored Pending (red short / green excess) + totals */}
          <LedgerTable title={`Issued (${formatDate(from)} – ${formatDate(to)})`} empty="No issues in this period."
            headers={UNIFIED_HEADERS}
            rows={d.issues.map((i: any) => [
              formatDate(i.date), i.batchNumber, i.processName, i.itemNumber, i.vendorDesignReference || '—',
              i.qty, wt(i.weight), i.receivedQty, pendingCell(i.qty, i.receivedQty, i.closed), formatCurrency(i.amount),
            ])}
            totalRow={['Total', '', '', '', '',
              d.summary.issued.qty, wt(d.summary.issued.weight),
              d.issues.reduce((s: number, i: any) => s + (i.receivedQty || 0), 0),
              d.summary.pending.qty, formatCurrency(d.summary.issued.amount),
            ]} />

          {/* 2) Received — same columns; Recd = qty received in that receipt */}
          <LedgerTable title={`Received (${formatDate(from)} – ${formatDate(to)})`} empty="No receipts in this period."
            headers={UNIFIED_HEADERS}
            rows={d.receipts.map((r: any) => [
              formatDate(r.date), r.batchNumber, r.processName, r.itemNumber, r.vendorDesignReference || '—',
              r.qty, wt(r.weight), r.recd, pendingCell(r.qty, r.recd + 0, false, r.pending), formatCurrency(r.amount),
            ])}
            totalRow={['Total', '', '', '', '', '', '', d.summary.received.qty, '', '']} />

          {/* 3) Under Process — what the vendor is physically holding right now (all dates) */}
          <LedgerTable title="Under Process — currently held by this vendor" empty="Vendor is holding nothing right now."
            headers={['Batch', 'Process', 'Item #', 'Colour', 'Vendor Ref', 'Pending Qty', 'Pending Wt']}
            rows={(d.underProcess ?? []).map((u: any) => [
              u.batchNumber, u.processName, u.itemNumber, u.color || '—', u.vendorDesignReference || '—',
              u.pendingQty, wt(u.pendingWeight),
            ])}
            totalRow={(d.underProcess ?? []).length ? ['Total', '', '', '', '', d.summary.underProcess.qty, wt(d.summary.underProcess.weight)] : undefined}
            pending />

          {/* 4) Short-close — outstanding balances */}
          <LedgerTable title="Short-Closed (outstanding balances)" empty="No outstanding balances."
            headers={['Closed', 'Batch', 'Process', 'Item #', 'Short Qty', 'Short Wt', 'Amount', 'Reason']}
            rows={d.outstanding.map((o: any) => [
              formatDate(o.date), o.batchNumber, o.processName, o.itemNumber,
              o.shortQty, wt(o.shortWeight), formatCurrency(o.amount), o.reason || '—',
            ])}
            totalRow={d.outstanding.length ? ['Total', '', '', '', d.summary.outstanding.qty, wt(d.summary.outstanding.weight), formatCurrency(d.summary.outstanding.amount), ''] : undefined}
            highlight />
        </div>
      )}
    </div>
  );
}

function SummaryCard({ icon: Icon, color, label, lines }: { icon: any; color: string; label: string; lines: string[] }) {
  return (
    <Card className="h-full">
      <CardContent className="flex h-full items-center gap-4 p-5">
        <div className={`flex size-12 shrink-0 items-center justify-center rounded-xl ${color}`}><Icon className="size-6" /></div>
        <div className="min-w-0">
          <div className="text-lg font-bold leading-tight">{lines[0]}</div>
          <div className="text-sm text-muted-foreground">{label}</div>
          {lines.slice(1).map((l, i) => <div key={i} className="text-xs text-muted-foreground">{l}</div>)}
        </div>
      </CardContent>
    </Card>
  );
}

function LedgerTable({ title, headers, rows, empty, highlight, pending, totalRow }: { title: string; headers: string[]; rows: any[][]; empty: string; highlight?: boolean; pending?: boolean; totalRow?: any[] }) {
  const rowTint = highlight ? 'bg-red-50/40' : pending ? 'bg-amber-50/40' : '';
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <span className="font-semibold">{title}</span>
          {rows.length > 0 && <Badge variant={pending ? 'warning' : highlight ? 'destructive' : 'secondary'}>{rows.length}</Badge>}
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: 880 }}>
              <thead className="bg-muted/40 text-left text-slate-600">
                <tr>{headers.map((h) => <th key={h} className="px-4 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={`border-t border-border ${rowTint}`}>
                    {r.map((c, j) => <td key={j} className="px-4 py-2">{c}</td>)}
                  </tr>
                ))}
              </tbody>
              {totalRow && (
                <tfoot>
                  <tr className="border-t-2 border-border bg-muted/60 font-semibold">
                    {totalRow.map((c, j) => <td key={j} className="px-4 py-2">{c}</td>)}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
