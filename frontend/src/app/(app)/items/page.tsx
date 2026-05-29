'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ColumnDef } from '@tanstack/react-table';
import { Plus, Pencil, Trash2, Search, Eye, ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/shared/status-badge';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { fileUrl, formatDate, SAMPLE_STATUS_LABELS } from '@/lib/utils';
import type { ItemListRow } from '@/lib/types';

export default function ItemsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const [search, setSearch] = React.useState('');
  const [sampleStatus, setSampleStatus] = React.useState('');

  const itemsQ = useQuery<ItemListRow[]>({
    queryKey: ['items', { search, sampleStatus }],
    queryFn: () => Api.items.list({ search: search || undefined, sampleStatus: sampleStatus || undefined }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => Api.items.remove(id),
    onSuccess: () => { toast.success('Item deleted.'); qc.invalidateQueries({ queryKey: ['items'] }); },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const columns: ColumnDef<ItemListRow>[] = [
    {
      id: 'image', header: '', enableSorting: false,
      cell: ({ row }) => row.original.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={fileUrl(row.original.thumbUrl)} alt="" className="size-11 rounded-md border border-border object-cover" />
      ) : (
        <div className="flex size-11 items-center justify-center rounded-md bg-muted text-muted-foreground"><ImageIcon className="size-4" /></div>
      ),
    },
    {
      accessorKey: 'sampleDesignCode', header: 'Sample Code',
      cell: ({ row }) => <Link href={`/items/${row.original.id}`} className="font-semibold hover:text-primary">{row.original.sampleDesignCode}</Link>,
    },
    {
      accessorKey: 'itemNumber', header: 'Item No.',
      cell: ({ row }) => (
        <div>
          <div>{row.original.itemNumber ?? '—'}</div>
          {row.original.collection && <div className="text-xs text-muted-foreground">{row.original.collection}</div>}
        </div>
      ),
    },
    { accessorKey: 'category', header: 'Category', cell: ({ row }) => row.original.category || '—' },
    { accessorKey: 'designType', header: 'Design', cell: ({ row }) => row.original.designType || '—' },
    { accessorKey: 'sampleStatus', header: 'Sample Status', cell: ({ row }) => <StatusBadge status={row.original.sampleStatus} /> },
    { accessorKey: 'updatedAt', header: 'Updated', cell: ({ row }) => formatDate(row.original.updatedAt) },
    {
      id: 'actions', header: () => <div className="text-right">Actions</div>, enableSorting: false,
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button variant="outline" size="icon" onClick={() => router.push(`/items/${row.original.id}`)}><Eye className="size-4" /></Button>
          <Button variant="outline" size="icon" onClick={() => router.push(`/items/${row.original.id}/edit`)}><Pencil className="size-4" /></Button>
          <Button variant="outline" size="icon" className="text-destructive hover:bg-destructive/10"
            onClick={() => confirm({
              title: 'Delete item?',
              message: `This permanently deletes ${row.original.sampleDesignCode} and all its process/image data.`,
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
        title="Item Master"
        subtitle="Permanent manufacturing blueprint for every jewellery design. Save drafts and complete details progressively."
        actions={<Button onClick={() => router.push('/items/new')}><Plus className="size-4" /> Create Item</Button>}
      />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search design code, name, collection…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="w-48">
            <Select value={sampleStatus} onChange={(e) => setSampleStatus(e.target.value)}>
              <option value="">All statuses</option>
              {Object.entries(SAMPLE_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <DataTable columns={columns} data={itemsQ.data ?? []} loading={itemsQ.isLoading}
            emptyTitle="No items yet" emptyDescription="Create your first design blueprint." />
        </CardContent>
      </Card>

      {dialog}
    </div>
  );
}
