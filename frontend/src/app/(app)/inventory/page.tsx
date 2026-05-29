'use client';

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ColumnDef } from '@tanstack/react-table';
import { Search, PackagePlus } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Field } from '@/components/shared/field';
import { formatCurrency, formatDate } from '@/lib/utils';

function AdjustDialog({ variant, open, onClose }: { variant: any; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = React.useState('IN');
  const [quantity, setQuantity] = React.useState('');
  const [note, setNote] = React.useState('');

  React.useEffect(() => { if (open) { setType('IN'); setQuantity(''); setNote(''); } }, [open]);

  const save = useMutation({
    mutationFn: () => Api.materials.adjustStock(variant.id, { type, quantity: Math.max(0, Math.trunc(Number(quantity || 0))), note: note || undefined }),
    onSuccess: () => {
      toast.success('Stock updated.');
      qc.invalidateQueries({ queryKey: ['stock'] });
      qc.invalidateQueries({ queryKey: ['stock-movements'] });
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <Dialog open={open} onClose={onClose} size="md"
      title={`Stock — ${variant?.variantName ?? ''}`}
      description={`Current stock: ${variant?.stockQty != null ? Math.trunc(Number(variant.stockQty)) : 0} pcs`}
      footer={<><Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending && <Spinner />} Apply</Button></>}>
      <div className="space-y-3">
        <Field label="Action">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="IN">Add stock (IN)</option>
            <option value="OUT">Remove stock (OUT)</option>
            <option value="ADJUST">Set exact balance (ADJUST)</option>
          </Select>
        </Field>
        <Field label={type === 'ADJUST' ? 'New balance' : 'Quantity'} hint="whole number">
          <Input type="number" step="1" min="0" value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/[^0-9]/g, ''))} />
        </Field>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. opening stock / purchase" /></Field>
      </div>
    </Dialog>
  );
}

export default function InventoryPage() {
  const [search, setSearch] = React.useState('');
  const [adjustVariant, setAdjustVariant] = React.useState<any>(null);

  const stockQ = useQuery({ queryKey: ['stock', { search }], queryFn: () => Api.materials.stock(search || undefined) });
  const movesQ = useQuery({ queryKey: ['stock-movements'], queryFn: () => Api.materials.movements() });

  const columns: ColumnDef<any>[] = [
    { accessorKey: 'variantCode', header: 'Code', cell: ({ row }) => <span className="font-semibold">{row.original.variantCode}</span> },
    {
      accessorKey: 'variantName', header: 'Material / Variant',
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.variantName}</div>
          <div className="text-xs text-muted-foreground">{row.original.materialName}{row.original.categoryName ? ` · ${row.original.categoryName}` : ''}</div>
        </div>
      ),
    },
    {
      id: 'specs', header: 'Specs', enableSorting: false,
      cell: ({ row }) => [row.original.size, row.original.color].filter(Boolean).join(' · ') || '—',
    },
    { accessorKey: 'price', header: 'Price/pc', cell: ({ row }) => formatCurrency(row.original.price) },
    {
      accessorKey: 'stockQty', header: 'In Stock',
      cell: ({ row }) => {
        const s = Math.trunc(Number(row.original.stockQty));
        return <Badge variant={s <= 0 ? 'destructive' : s < 20 ? 'warning' : 'success'}>{s} pcs</Badge>;
      },
    },
    {
      id: 'actions', header: () => <div className="text-right">Actions</div>, enableSorting: false,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => setAdjustVariant(row.original)}><PackagePlus className="size-4" /> Stock</Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Raw Materials Inventory" subtitle="Raw material stock on hand. Consumed when a Sticking material-issue voucher is created." />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search material / variant / code…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardContent className="p-4">
          <DataTable columns={columns} data={stockQ.data ?? []} loading={stockQ.isLoading}
            emptyTitle="No materials yet" emptyDescription="Add material variants first." />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="border-b border-border px-5 py-3 font-semibold">Recent Stock Movements</div>
          {(movesQ.data ?? []).length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">No movements yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-slate-600">
                  <tr><th className="px-4 py-2">Date</th><th className="px-4 py-2">Material</th><th className="px-4 py-2">Type</th><th className="px-4 py-2">Change</th><th className="px-4 py-2">Balance</th><th className="px-4 py-2">Ref</th><th className="px-4 py-2">Note</th></tr>
                </thead>
                <tbody>
                  {(movesQ.data ?? []).map((m: any) => (
                    <tr key={m.id} className="border-t border-border">
                      <td className="px-4 py-2">{formatDate(m.date)}</td>
                      <td className="px-4 py-2">{m.variantName}</td>
                      <td className="px-4 py-2">
                        <Badge variant={m.type === 'IN' ? 'success' : m.type === 'OUT' ? 'destructive' : 'secondary'}>{m.type}</Badge>
                      </td>
                      <td className={`px-4 py-2 font-medium ${m.quantity >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{m.quantity >= 0 ? `+${m.quantity}` : m.quantity}</td>
                      <td className="px-4 py-2">{m.balanceAfter}</td>
                      <td className="px-4 py-2 text-muted-foreground">{m.refType === 'sticking_batch' ? `Sticking #${m.refId}` : m.refType}</td>
                      <td className="px-4 py-2 text-muted-foreground">{m.note || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <AdjustDialog variant={adjustVariant} open={!!adjustVariant} onClose={() => setAdjustVariant(null)} />
    </div>
  );
}
