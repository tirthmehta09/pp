'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ColumnDef } from '@tanstack/react-table';
import { Plus, Eye, Trash2, Search, Share2, FileDown, Copy, PackageCheck, Pencil, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { CastingStatusBadge } from '@/components/shared/status-badge';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { formatDate } from '@/lib/utils';
import { BatchForm } from '../issue/batch-form';
import { BatchDetail } from '../issue/batch-detail';
import { ReceiveForm } from '../receipt/receive-form';

function ShareDialog({ batchId, open, onClose }: { batchId: number | null; open: boolean; onClose: () => void }) {
  const { data: batch, isLoading } = useQuery({
    queryKey: ['casting-batch', batchId], queryFn: () => Api.casting.batch(batchId!), enabled: open && !!batchId,
  });
  const copy = (url: string) =>
    navigator.clipboard?.writeText(url).then(() => toast.success('Link copied.'), () => toast.error('Could not copy.'));

  // Folder tree: Process › Vendor › [Issue slip + receipt slips]
  const folders = React.useMemo(() => {
    const map = new Map<string, { processName: string; vendors: Map<string, any> }>();
    for (const it of batch?.items ?? []) {
      if (!map.has(it.processName)) map.set(it.processName, { processName: it.processName, vendors: new Map() });
      const f = map.get(it.processName)!;
      if (!f.vendors.has(it.vendorName)) f.vendors.set(it.vendorName, { vendorName: it.vendorName, vendorCode: it.vendorCode, vendorId: it.vendorId, processId: it.processId, receipts: [] });
    }
    for (const r of batch?.receipts ?? []) {
      const v = map.get(r.processName)?.vendors.get(r.vendorName);
      if (v) v.receipts.push(r);
    }
    return Array.from(map.values());
  }, [batch]);

  return (
    <Dialog open={open} onClose={onClose} size="md" title="Slips — Process › Vendor"
      description="Open or copy any issue / receipt slip.">
      {isLoading || !batch ? <div className="flex justify-center py-8"><Spinner className="text-primary" /></div> : (
        <div className="space-y-2">
          {folders.map((f) => (
            <details key={f.processName} className="rounded-lg border border-border">
              <summary className="cursor-pointer select-none bg-muted/50 px-3 py-2 text-sm font-semibold">📁 {f.processName}</summary>
              <div className="space-y-1 p-2">
                {Array.from(f.vendors.values()).map((v: any) => (
                  <details key={v.vendorName} className="rounded-md border border-border">
                    <summary className="cursor-pointer select-none px-3 py-1.5 text-sm font-medium">📂 {v.vendorCode} · {v.vendorName}</summary>
                    <div className="space-y-1 px-3 pb-2">
                      <SlipRow label="🧾 Issue Slip" url={Api.casting.pdfUrl(batch.id, v.vendorId, v.processId)} onCopy={copy} />
                      {v.receipts.map((r: any) => (
                        <SlipRow key={r.id} label={`📥 ${r.receiptNumber} · ${r.qty} pcs`} url={Api.casting.receiptPdfUrl(r.id)} onCopy={copy} />
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          ))}
          {folders.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No slips yet.</p>}
        </div>
      )}
    </Dialog>
  );
}

function SlipRow({ label, url, onCopy }: { label: string; url: string; onCopy: (u: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-border bg-card px-2.5 py-1.5 text-sm">
      <span>{label}</span>
      <div className="flex gap-1">
        <a href={url} target="_blank" rel="noreferrer"><Button variant="outline" size="sm"><FileDown className="size-4" /> Open</Button></a>
        <Button variant="outline" size="sm" onClick={() => onCopy(url)}><Copy className="size-4" /> Copy</Button>
      </div>
    </div>
  );
}

export default function BatchManagementPage() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [formOpen, setFormOpen] = React.useState(false);
  const [detailId, setDetailId] = React.useState<number | null>(null);
  const [shareId, setShareId] = React.useState<number | null>(null);
  const [receiveId, setReceiveId] = React.useState<number | null>(null);

  const batchesQ = useQuery({
    queryKey: ['casting-batches', { search, status }],
    queryFn: () => Api.casting.batches({ search: search || undefined, status: status || undefined }),
  });

  // Production Management focuses on what the floor needs to act on now:
  // ACTIVE batches only — NOT closed at the batch level AND not fully Completed.
  // Closed and Completed batches live on the Batch Inventory page.
  const allRows = batchesQ.data ?? [];
  const rows = allRows.filter((b: any) => !b.closed && b.displayStatus !== 'Completed');

  const remove = useMutation({
    mutationFn: (id: number) => Api.casting.removeBatch(id),
    onSuccess: () => { toast.success('Batch deleted.'); qc.invalidateQueries({ queryKey: ['casting-batches'] }); },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const columns: ColumnDef<any>[] = [
    { accessorKey: 'batchNumber', header: 'Batch #', cell: ({ row }) => <span className="font-semibold">{row.original.batchNumber}</span> },
    {
      id: 'processes', header: 'Processes reached', enableSorting: false,
      cell: ({ row }) => (
        <div className="flex flex-wrap items-center gap-1">
          {(row.original.processNames ?? []).map((n: string, i: number) => (
            <React.Fragment key={n}>
              {i > 0 && <span className="text-muted-foreground">›</span>}
              <Badge variant="outline">{n}</Badge>
            </React.Fragment>
          ))}
        </div>
      ),
    },
    { accessorKey: 'batchDate', header: 'Date', cell: ({ row }) => formatDate(row.original.batchDate) },
    {
      id: 'designs', header: 'Production', enableSorting: false,
      cell: ({ row }) => (
        <div className="text-sm">
          <Badge variant="info">{row.original.designCount} design(s)</Badge>
          <div className="mt-1 text-xs text-muted-foreground">{row.original.piecesOrdered} pcs ordered</div>
        </div>
      ),
    },
    {
      id: 'status', header: 'Status', enableSorting: false,
      cell: ({ row }) => {
        const s = row.original.displayStatus ?? '—';
        const cls = s === 'Completed' ? 'bg-emerald-100 text-emerald-700'
          : s === 'In Process' ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-700';
        return (
          <div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>{s}</span>
            <div className="mt-1 text-xs text-muted-foreground">
              {row.original.openStages > 0 ? `${row.original.openStages} step(s) awaiting receipt` : 'All steps received'}
            </div>
          </div>
        );
      },
    },
    {
      id: 'actions', header: () => <div className="text-right">Actions</div>, enableSorting: false,
      cell: ({ row }) => {
        const done = row.original.status === 'COMPLETED';
        return (
          <div className="flex justify-end gap-1">
            <Button variant="outline" size="icon" title="View" onClick={() => setDetailId(row.original.id)}><Eye className="size-4" /></Button>
            <Button variant="outline" size="icon" title="Edit steps" onClick={() => setDetailId(row.original.id)}><Pencil className="size-4" /></Button>
            <Button variant="outline" size="icon" title="Issue for next process" onClick={() => setDetailId(row.original.id)}><Send className="size-4" /></Button>
            <Button variant="outline" size="icon" title={done ? 'Fully received' : 'Receive'} disabled={done} onClick={() => setReceiveId(row.original.id)}><PackageCheck className="size-4" /></Button>
            <Button variant="outline" size="icon" title="Slips" onClick={() => setShareId(row.original.id)}><Share2 className="size-4" /></Button>
            <Button variant="outline" size="icon" className="text-destructive hover:bg-destructive/10" title="Delete"
              onClick={() => confirm({ title: 'Delete batch?', message: `This deletes batch ${row.original.batchNumber} and its receipts.`, onConfirm: () => remove.mutateAsync(row.original.id) })}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Production Management"
        subtitle="Active and in-process batches only. Completed and short-closed batches live on Batch Inventory."
        actions={<Button onClick={() => setFormOpen(true)}><Plus className="size-4" /> New Production Batch</Button>}
      />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search batch number or vendor…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <DataTable columns={columns} data={rows} loading={batchesQ.isLoading}
            pageSize={10} pageSizeOptions={[10, 25, 50, 100]}
            emptyTitle="No active batches"
            emptyDescription="Everything is shipped — create a new batch when production resumes, or open Batch Inventory to browse history." />
        </CardContent>
      </Card>

      <BatchForm open={formOpen} onClose={() => setFormOpen(false)} onSaved={(id) => { setFormOpen(false); setDetailId(id); }} />
      <BatchDetail batchId={detailId} open={detailId != null} onClose={() => setDetailId(null)} />
      <ShareDialog batchId={shareId} open={shareId != null} onClose={() => setShareId(null)} />
      <ReceiveForm open={receiveId != null} initialBatchId={receiveId} onClose={() => setReceiveId(null)} />
      {dialog}
    </div>
  );
}
