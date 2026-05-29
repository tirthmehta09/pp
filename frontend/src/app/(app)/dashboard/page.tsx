'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Package, Layers, PackageCheck, AlertTriangle, Clock,
  Boxes, Wallet, PackageOpen, ArrowDownLeft, XCircle,
  Truck, Factory, Receipt, Gem,
} from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { formatCurrency } from '@/lib/utils';

const fmtW = (g: number) => (g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${(g ?? 0).toFixed(0)} g`);

export default function DashboardPage() {
  const { user } = useAuth();
  // Refetch on focus + every 30s so the dashboard stays live as receipts,
  // issues, returns and short-closes happen elsewhere in the app.
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => Api.dashboard(),
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });

  if (isLoading || !data) {
    return <div className="flex items-center justify-center py-20"><Spinner className="size-6 text-primary" /></div>;
  }

  const prodInv = data.productionInventory ?? { finished: 0, inHouse: 0, atVendor: 0, total: 0 };
  const mats = data.materialsSummary ?? { openVouchers: 0, totalPending: 0, totalIssued: 0, totalReturned: 0, totalConsumed: 0 };

  const cards = [
    { label: 'Production-Ready Items', value: data.productionReadyItems, sub: `${data.totalItems} total`, icon: Package, href: '/items', color: 'bg-primary/10 text-primary' },
    { label: 'Active Batches', value: data.pendingBatches, sub: `${data.openBatches} new · ${data.partialBatches} partial`, icon: Layers, href: '/casting/batches', color: 'bg-amber-100 text-amber-600' },
    { label: 'Production Inventory', value: prodInv.total, sub: `✓${prodInv.finished} · 🏭${prodInv.inHouse} · 🚚${prodInv.atVendor}`, icon: PackageCheck, href: '/produced', color: 'bg-violet-100 text-violet-600' },
    { label: 'Materials At Vendors', value: mats.totalPending, sub: `${mats.openVouchers} open voucher(s)`, icon: Truck, href: '/material-issues', color: 'bg-sky-100 text-sky-600' },
    { label: 'Payable This Month', value: formatCurrency(data.payableThisMonthTotal), sub: 'job-work value issued', icon: Wallet, href: '/vendor-ledger', color: 'bg-emerald-100 text-emerald-600' },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Welcome back, {user?.fullName} 👋</h1>
        <p className="text-sm text-muted-foreground">Whole-business overview — production, raw materials, vendors, money. Auto-refreshes every 30 s.</p>
      </div>

      {/* KPI cards — 5 tiles, wraps on smaller screens */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((c) => (
          <Link key={c.label} href={c.href} className="block">
            <Card className="transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-muted-foreground">{c.label}</span>
                  <div className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${c.color}`}><c.icon className="size-4" /></div>
                </div>
                <div className="mt-2 text-2xl font-bold leading-tight tracking-tight">{c.value}</div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{c.sub}</div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* Production-inventory breakdown (under headline tile) */}
      <Card>
        <CardContent className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-4">
          <ProdStat icon={PackageCheck} colour="emerald" label="Packed & ready" value={prodInv.finished} href="/produced" />
          <ProdStat icon={Factory} colour="amber" label="In-house (mid-chain)" value={prodInv.inHouse} href="/produced" />
          <ProdStat icon={Truck} colour="sky" label="At vendor" value={prodInv.atVendor} href="/produced" />
          <ProdStat icon={Layers} colour="violet" label="Short-closed batches" value={data.closedBatches ?? 0} href="/batch-inventory" />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Aging pending batches */}
        <Panel title="Aging — Pending Batches" icon={Clock} moreHref="/casting/batches" showMore={data.agingPending.length > 3}>
          {data.agingPending.length === 0 ? <Empty text="Nothing pending. All caught up." /> : (
            <div className="space-y-2">
              {data.agingPending.slice(0, 3).map((b: any) => (
                <Link key={b.batchNumber} href="/casting/batches" className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent/40">
                  <div className="min-w-0">
                    <div className="font-medium">{b.batchNumber} <span className="text-muted-foreground">· {b.processName}</span></div>
                    <div className="truncate text-xs text-muted-foreground">{b.vendors.join(', ')}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="warning">{b.pendingQty} pcs</Badge>
                    <Badge variant={b.days >= 14 ? 'destructive' : 'secondary'}>{b.days}d</Badge>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Panel>

        {/* Process Workload — full breakdown of every production process with
            current pcs in flight. Includes processes at 0 pcs (greyed) so the
            user always sees the complete production flow at a glance. */}
        <Panel title="Process Workload (in process)" icon={Boxes}>
          {(data.processWorkload ?? []).length === 0 ? <Empty text="No production processes configured." /> : (
            <div className="max-h-64 overflow-y-auto pr-1">
              <table className="w-full text-sm">
                <tbody>
                  {data.processWorkload.map((p: any) => {
                    const max = Math.max(...data.processWorkload.map((x: any) => x.pendingQty), 1);
                    const pct = (p.pendingQty / max) * 100;
                    const busy = p.pendingQty > 0;
                    return (
                      <tr key={p.name} className="border-t border-border first:border-t-0">
                        <td className="py-2 pr-2">
                          <div className={`text-sm font-medium ${busy ? 'text-foreground' : 'text-muted-foreground'}`}>{p.name}</div>
                          {busy && (
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                            </div>
                          )}
                        </td>
                        <td className="py-2 text-right align-top">
                          <span className={`tabular-nums ${busy ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                            {p.pendingQty}
                          </span>
                          <span className="ml-1 text-xs text-muted-foreground">pcs</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Vendor holdings — raw materials still with karigars */}
        <Panel title="Vendor Material Holdings" icon={Truck} moreHref="/material-issues" showMore={(data.topVendorHoldings ?? []).length > 5}>
          {(!data.topVendorHoldings || data.topVendorHoldings.length === 0) ? <Empty text="No raw materials currently with any vendor." /> : (
            <div className="space-y-2">
              {data.topVendorHoldings.slice(0, 5).map((v: any) => (
                <Link key={v.vendorId} href="/material-issues" className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent/40">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{v.name}</div>
                    <div className="text-xs text-muted-foreground">{v.vouchers} voucher{v.vouchers === 1 ? '' : 's'}</div>
                  </div>
                  <Badge variant="info" className="font-semibold">{v.qty} pcs</Badge>
                </Link>
              ))}
            </div>
          )}
        </Panel>

        {/* Low-stock raw materials */}
        <Panel title="Low Stock — Raw Materials" icon={Gem} danger={(data.lowStockMaterials ?? []).length > 0} moreHref="/inventory" showMore={(data.lowStockMaterials ?? []).length > 5}>
          {(!data.lowStockMaterials || data.lowStockMaterials.length === 0) ? <Empty text="All raw materials above safe stock level." /> : (
            <div className="space-y-2">
              {data.lowStockMaterials.slice(0, 5).map((m: any) => (
                <Link key={m.id} href="/inventory" className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent/40">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{m.variantName}</div>
                    <div className="font-mono text-xs text-muted-foreground">{m.variantCode}</div>
                  </div>
                  <Badge variant={m.stockQty === 0 ? 'destructive' : m.stockQty < 20 ? 'destructive' : 'warning'}>
                    {m.stockQty}{m.unit ? ` ${m.unit}` : ''}
                  </Badge>
                </Link>
              ))}
            </div>
          )}
        </Panel>

        {/* Payable per vendor */}
        <Panel title="Job-Work Payable — This Month" icon={Wallet} moreHref="/vendor-ledger" showMore={data.payableByVendor.length > 3}>
          {data.payableByVendor.length === 0 ? <Empty text="No job-work issued this month." /> : (
            <div className="space-y-2">
              {data.payableByVendor.slice(0, 3).map((v: any) => (
                <div key={v.name} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                  <span className="truncate">{v.name}</span>
                  <span className="font-semibold">{formatCurrency(v.amount)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between border-t border-border px-3 pt-2 text-sm font-bold">
                <span>Total</span><span className="text-primary">{formatCurrency(data.payableThisMonthTotal)}</span>
              </div>
            </div>
          )}
        </Panel>

        {/* Recent activity */}
        <Panel title="Recent Activity" icon={Clock} moreHref="/casting/batches" showMore={data.recentActivity.length > 8}>
          {data.recentActivity.length === 0 ? <Empty text="No activity yet." /> : (
            <div className="space-y-2">
              {data.recentActivity.slice(0, 8).map((a: any, i: number) => {
                const meta = a.type === 'issue'
                  ? { icon: PackageOpen, c: 'text-primary' }
                  : a.type === 'receipt'
                    ? { icon: ArrowDownLeft, c: 'text-emerald-600' }
                    : { icon: XCircle, c: 'text-amber-600' };
                return (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <meta.icon className={`mt-0.5 size-4 shrink-0 ${meta.c}`} />
                    <span className="text-foreground/90">{a.text}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      {/* Material flow strip — issued / returned / consumed / pending across all open vouchers */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
          <StripStat icon={Receipt} colour="primary" label="Materials issued" value={mats.totalIssued} />
          <StripStat icon={ArrowDownLeft} colour="emerald" label="Returned to stock" value={mats.totalReturned} />
          <StripStat icon={Factory} colour="sky" label="Consumed (used)" value={mats.totalConsumed} />
          <StripStat icon={Truck} colour="amber" label="Still with vendors" value={mats.totalPending} />
        </CardContent>
      </Card>

      {/* Short-closed write-offs note */}
      {data.outstandingLines > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4">
            <div className="flex items-center gap-2 text-sm">
              <AlertTriangle className="size-4 text-red-500" />
              <span><strong>{data.outstandingLines}</strong> short-closed line(s) outstanding — {data.outstandingShortQty} pcs / {fmtW(data.outstandingShortWeight)} not returned.</span>
            </div>
            <Link href="/vendor-ledger" className="text-sm text-primary hover:underline">View in Vendor Ledger →</Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ProdStat({ icon: Icon, colour, label, value, href }: { icon: any; colour: 'emerald'|'amber'|'sky'|'violet'; label: string; value: number; href: string }) {
  const cls: Record<string, string> = {
    emerald: 'bg-emerald-50 text-emerald-700',
    amber:   'bg-amber-50 text-amber-700',
    sky:     'bg-sky-50 text-sky-700',
    violet:  'bg-violet-50 text-violet-700',
  };
  return (
    <Link href={href} className="flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-accent/40">
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${cls[colour]}`}><Icon className="size-4" /></div>
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        <div className="text-lg font-bold tabular-nums">{value}<span className="ml-1 text-xs font-normal text-muted-foreground">pcs</span></div>
      </div>
    </Link>
  );
}

function StripStat({ icon: Icon, colour, label, value }: { icon: any; colour: 'primary'|'emerald'|'sky'|'amber'; label: string; value: number }) {
  const cls: Record<string, string> = {
    primary: 'text-primary',
    emerald: 'text-emerald-600',
    sky:     'text-sky-600',
    amber:   'text-amber-600',
  };
  return (
    <div className="flex items-center gap-3">
      <Icon className={`size-5 ${cls[colour]}`} />
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-lg font-bold tabular-nums">{value}</div>
      </div>
    </div>
  );
}

function Panel({ title, icon: Icon, danger, children, moreHref, showMore }: { title: string; icon: any; danger?: boolean; children: React.ReactNode; moreHref?: string; showMore?: boolean }) {
  return (
    <Card>
      <CardContent className="flex h-full flex-col p-5">
        <h2 className={`mb-4 flex items-center gap-2 font-semibold ${danger ? 'text-red-600' : ''}`}>
          <Icon className="size-4" /> {title}
        </h2>
        <div className="flex-1">{children}</div>
        {moreHref && showMore && (
          <Link href={moreHref} className="mt-3 inline-block text-sm font-medium text-primary hover:underline">
            Show more →
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-4 text-sm text-muted-foreground">{text}</p>;
}

function Bars({ items, barClass }: { items: { name: string; value: number; label: string }[]; barClass: string }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-2.5">
      {items.map((i) => (
        <div key={i.name}>
          <div className="mb-1 flex justify-between text-sm"><span className="truncate">{i.name}</span><span className="font-semibold">{i.label}</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full ${barClass}`} style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
