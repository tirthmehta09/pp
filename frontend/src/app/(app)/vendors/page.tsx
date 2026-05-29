'use client';

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ColumnDef } from '@tanstack/react-table';
import { Plus, Pencil, Trash2, Search, Truck } from 'lucide-react';
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
import { VendorForm } from './vendor-form';
import type { ProcessMeta, Vendor } from '@/lib/types';

export default function VendorsPage() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const [search, setSearch] = React.useState('');
  const [processId, setProcessId] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [formOpen, setFormOpen] = React.useState(false);
  const [editId, setEditId] = React.useState<number | null>(null);

  const processesQ = useQuery<ProcessMeta[]>({ queryKey: ['processes'], queryFn: () => Api.processes() });

  const vendorsQ = useQuery<Vendor[]>({
    queryKey: ['vendors', { search, processId, status }],
    queryFn: () =>
      Api.vendors.list({
        search: search || undefined,
        processId: processId || undefined,
        status: status || undefined,
      }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => Api.vendors.remove(id),
    onSuccess: () => {
      toast.success('Vendor deleted.');
      qc.invalidateQueries({ queryKey: ['vendors'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  // Bumped on every open so the form remounts fresh — no stale values from a prior entry.
  const [formKey, setFormKey] = React.useState(0);
  const openAdd = () => { setEditId(null); setFormKey((k) => k + 1); setFormOpen(true); };
  const openEdit = (id: number) => { setEditId(id); setFormKey((k) => k + 1); setFormOpen(true); };

  const columns: ColumnDef<Vendor>[] = [
    {
      accessorKey: 'vendorCode',
      header: 'Code',
      cell: ({ row }) => <span className="font-semibold">{row.original.vendorCode}</span>,
    },
    {
      accessorKey: 'vendorName',
      header: 'Vendor',
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.vendorName}</div>
          {row.original.shortName && (
            <div className="text-xs text-muted-foreground">{row.original.shortName}</div>
          )}
        </div>
      ),
    },
    {
      id: 'contact',
      header: 'Contact',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="text-sm">
          {row.original.contactPerson && <div>{row.original.contactPerson}</div>}
          <div className="text-muted-foreground">{row.original.mobile || '—'}</div>
        </div>
      ),
    },
    {
      id: 'processes',
      header: 'Processes',
      enableSorting: false,
      cell: ({ row }) =>
        row.original.processNames ? (
          <div className="flex flex-wrap gap-1">
            {row.original.processNames.split(', ').map((p) => (
              <Badge key={p} variant="outline">{p}</Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: 'actions',
      header: () => <div className="text-right">Actions</div>,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button variant="outline" size="icon" onClick={() => openEdit(row.original.id)}>
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="text-destructive hover:bg-destructive/10"
            onClick={() =>
              confirm({
                title: 'Delete vendor?',
                message: `This will permanently delete ${row.original.vendorName}.`,
                onConfirm: () => remove.mutateAsync(row.original.id),
              })
            }
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Vendor Master"
        subtitle="Manufacturing & job-work vendors and the processes they support."
        actions={
          <Button onClick={openAdd}>
            <Plus className="size-4" /> Add Vendor
          </Button>
        }
      />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search name, code, mobile…"
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="w-52">
            <SearchableSelect
              value={processId}
              placeholder="All processes"
              onChange={(v) => setProcessId(v)}
              options={[{ value: '', label: 'All processes' }, ...((processesQ.data ?? []).map((p) => ({ value: p.id, label: p.name })))]}
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
          <DataTable
            columns={columns}
            data={vendorsQ.data ?? []}
            loading={vendorsQ.isLoading}
            emptyTitle="No vendors found"
            emptyDescription="Add your first vendor to get started."
          />
        </CardContent>
      </Card>

      <VendorForm key={formKey} open={formOpen} onClose={() => setFormOpen(false)} vendorId={editId} />
      {dialog}
    </div>
  );
}
