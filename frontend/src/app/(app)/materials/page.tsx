'use client';

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ColumnDef } from '@tanstack/react-table';
import { Plus, Pencil, Trash2, Search, ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/shared/status-badge';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { fileUrl, formatCurrency } from '@/lib/utils';
import { VariantForm } from './variant-form';
import type { Category, MaterialVariant } from '@/lib/types';

export default function MaterialsPage() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const [search, setSearch] = React.useState('');
  const [categoryId, setCategoryId] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [formOpen, setFormOpen] = React.useState(false);
  const [editId, setEditId] = React.useState<number | null>(null);
  // Bumped on every open so the form remounts fresh — no stale values from a prior entry.
  const [formKey, setFormKey] = React.useState(0);
  const openAdd = () => { setEditId(null); setFormKey((k) => k + 1); setFormOpen(true); };
  const openEdit = (id: number) => { setEditId(id); setFormKey((k) => k + 1); setFormOpen(true); };

  const categoriesQ = useQuery<Category[]>({ queryKey: ['categories'], queryFn: () => Api.materials.categories() });

  const variantsQ = useQuery<MaterialVariant[]>({
    queryKey: ['variants', { search, categoryId, status }],
    queryFn: () =>
      Api.materials.variants({
        search: search || undefined,
        categoryId: categoryId || undefined,
        status: status || undefined,
      }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => Api.materials.removeVariant(id),
    onSuccess: () => {
      toast.success('Variant deleted.');
      qc.invalidateQueries({ queryKey: ['variants'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const columns: ColumnDef<MaterialVariant>[] = [
    {
      id: 'image', header: '', enableSorting: false,
      cell: ({ row }) =>
        row.original.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fileUrl(row.original.imagePath)} alt="" className="size-11 rounded-md border border-border object-cover" />
        ) : (
          <div className="flex size-11 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <ImageIcon className="size-4" />
          </div>
        ),
    },
    { accessorKey: 'variantCode', header: 'Code', cell: ({ row }) => <span className="font-semibold">{row.original.variantCode}</span> },
    {
      accessorKey: 'variantName', header: 'Material / Variant',
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.variantName}</div>
          <div className="text-xs text-muted-foreground">{row.original.materialName}</div>
        </div>
      ),
    },
    {
      id: 'genCode', header: 'Material Code', enableSorting: false,
      cell: ({ row }) =>
        row.original.code ? (
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">{row.original.code}</code>
        ) : <span className="text-muted-foreground">—</span>,
    },
    { accessorKey: 'categoryName', header: 'Category', cell: ({ row }) => row.original.categoryName || '—' },
    {
      id: 'specs', header: 'Specs', enableSorting: false,
      cell: ({ row }) => {
        const specs = [row.original.size, row.original.color, row.original.finish, row.original.shape].filter(Boolean);
        return specs.length ? (
          <div className="flex flex-wrap gap-1">{specs.map((s, i) => <Badge key={i} variant="outline">{s}</Badge>)}</div>
        ) : <span className="text-muted-foreground">—</span>;
      },
    },
    {
      id: 'vendors', header: 'Vendors', enableSorting: false,
      cell: ({ row }) => <Badge variant="info">{row.original.vendorCount ?? 0} vendor(s)</Badge>,
    },
    { id: 'price', header: 'From', cell: ({ row }) => formatCurrency(row.original.minPrice) },
    { accessorKey: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    {
      id: 'actions', header: () => <div className="text-right">Actions</div>, enableSorting: false,
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button variant="outline" size="icon" onClick={() => openEdit(row.original.id)}>
            <Pencil className="size-4" />
          </Button>
          <Button variant="outline" size="icon" className="text-destructive hover:bg-destructive/10"
            onClick={() => confirm({
              title: 'Delete variant?',
              message: `This will permanently delete ${row.original.variantName}.`,
              onConfirm: () => remove.mutateAsync(row.original.id),
            })}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Material Variant Master"
        subtitle="Raw materials & components — stones, pearls, hooks, chains, meena colors, packaging…"
        actions={<Button onClick={openAdd}><Plus className="size-4" /> Add Variant</Button>}
      />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search material / variant / code…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="w-52">
            <SearchableSelect
              value={categoryId}
              placeholder="All categories"
              onChange={(v) => setCategoryId(v)}
              options={[{ value: '', label: 'All categories' }, ...((categoriesQ.data ?? []).map((c) => ({ value: String(c.id), label: c.name })))]}
            />
          </div>
          <div className="w-36">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All status</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <DataTable columns={columns} data={variantsQ.data ?? []} loading={variantsQ.isLoading}
            emptyTitle="No material variants yet" emptyDescription="Add your first variant to build the catalog." />
        </CardContent>
      </Card>

      <VariantForm key={formKey} open={formOpen} onClose={() => setFormOpen(false)} variantId={editId} />
      {dialog}
    </div>
  );
}
