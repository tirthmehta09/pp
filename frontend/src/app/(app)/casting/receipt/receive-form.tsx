'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Badge } from '@/components/ui/badge';
import { Field, SectionTitle } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';

interface RowInput { receivedQty: string; receivedWeight: string; remarks: string }
// Per-material-line input for the receive-time materials section.
//   - used: qty consumed in production. Auto-defaults to BOM × sticking pcs
//     received NOW (same formula the system used at issue time), editable
//     if the vendor used more (waste) or less.
//   - excessMode: what happens to the leftover (pending − used)?
//       'return' → vendor returned the excess (input qty, default = full).
//       'keep'   → vendor keeps it for future jobs (stays pending).
//   - returnQty: only used when excessMode = 'return'.
interface MatReturnRow {
  used: string;
  excessMode: 'return' | 'keep';
  returnQty: string;
}
interface MatReturnInput { [lineId: number]: MatReturnRow }

export function ReceiveForm({
  open,
  onClose,
  initialBatchId,
}: {
  open: boolean;
  onClose: () => void;
  initialBatchId?: number | null;
}) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [batchId, setBatchId] = React.useState<number | ''>('');
  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [stageProcessId, setStageProcessId] = React.useState<number | ''>('');
  const [receiptDate, setReceiptDate] = React.useState(today);
  const [notes, setNotes] = React.useState('');
  const [inputs, setInputs] = React.useState<Record<number, RowInput>>({});
  // For sticking stages: per-stage material return inputs. Keyed by batchItemId
  // (the sticking stage id), then by materialIssueLineId. Lets the user decide
  // per-material whether the vendor is returning extras or keeping them.
  const [matReturns, setMatReturns] = React.useState<Record<number, MatReturnInput>>({});

  const batchesQ = useQuery({ queryKey: ['casting-batches-open'], queryFn: () => Api.casting.batches(), enabled: open });
  const batchQ = useQuery({
    queryKey: ['casting-batch', batchId],
    queryFn: () => Api.casting.batch(Number(batchId)),
    enabled: open && !!batchId,
  });
  const pendingQ = useQuery({
    queryKey: ['casting-pending', batchId, vendorId],
    queryFn: () => Api.casting.pending(Number(batchId), Number(vendorId)),
    enabled: open && !!batchId && !!vendorId,
  });

  React.useEffect(() => {
    if (open) {
      setBatchId(initialBatchId ?? ''); setVendorId(''); setStageProcessId(''); setReceiptDate(today); setNotes(''); setInputs({}); setMatReturns({});
    }
  }, [open, initialBatchId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Distinct processes among this vendor's pending stages — a receipt is per process.
  const pendingItems = pendingQ.data?.items ?? [];
  const processesInList = React.useMemo(() => {
    const m = new Map<number, string>();
    for (const it of pendingItems) if (it.processId) m.set(it.processId, it.processName);
    return Array.from(m.entries()).map(([id, name]) => ({ id, name }));
  }, [pendingItems]);

  // Default to the first process so each receipt covers a single process.
  React.useEffect(() => {
    if (processesInList.length && !processesInList.some((p) => p.id === stageProcessId)) {
      setStageProcessId(processesInList[0].id);
    }
  }, [processesInList]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleItems = stageProcessId ? pendingItems.filter((it: any) => it.processId === stageProcessId) : pendingItems;

  // Default received = pending when items load.
  React.useEffect(() => {
    if (pendingQ.data?.items) {
      const init: Record<number, RowInput> = {};
      for (const it of pendingQ.data.items) {
        init[it.id] = {
          receivedQty: String(it.pendingQty > 0 ? it.pendingQty : 0),
          receivedWeight: it.pendingWeight > 0 ? String(it.pendingWeight) : '',
          remarks: '',
        };
      }
      setInputs(init);
    }
  }, [pendingQ.data]);

  const setInput = (id: number, patch: Partial<RowInput>) =>
    setInputs((s) => ({ ...s, [id]: { ...s[id], ...patch } }));

  // Guard against double-clicks racing the React re-render — once submitted, the
  // ref locks until success/error. Without this, an impatient user clicking Save
  // twice in the same tick can fire two parallel createReceipt calls (the button
  // hasn't visually flipped to disabled yet on the second click).
  const submittingRef = React.useRef(false);
  const create = useMutation({
    mutationFn: async () => {
      const items = visibleItems
        .map((it: any) => ({
          batchItemId: it.id,
          receivedQty: Number(inputs[it.id]?.receivedQty || 0),
          receivedWeight: Number(inputs[it.id]?.receivedWeight || 0),
          remarks: inputs[it.id]?.remarks || undefined,
        }))
        .filter((r: any) => r.receivedQty !== 0 || r.receivedWeight !== 0);
      if (!items.length) throw new Error('Enter received quantity for at least one item.');
      // 1. Create the receipt for the sticking pieces.
      const receipt = await Api.casting.createReceipt({
        batchId: Number(batchId), vendorId: Number(vendorId),
        receiptDate, notes: notes || undefined, items,
      });
      // 2. For each sticking stage being received, also record material
      //    consumption + return. "used" → consumedQty (written off, no stock
      //    movement). Excess in 'return' mode → returnedQty (stock IN).
      //    Excess in 'keep' mode → nothing recorded (stays pending).
      type RetLine = { lineId: number; returnedQty: number; consumedQty?: number };
      const returnsByIssue: Record<number, RetLine[]> = {};
      for (const it of visibleItems) {
        const issue = it.materialIssue;
        if (!issue) continue;
        const rowReturns: MatReturnInput = matReturns[it.id] ?? {};
        for (const line of issue.lines) {
          const cfg = rowReturns[line.lineId];
          if (!cfg) continue;
          const used = Math.max(0, Math.trunc(Number(cfg.used || 0)));
          const excess = Math.max(0, line.pendingQty - used);
          const ret = cfg.excessMode === 'return'
            ? Math.min(excess, Math.max(0, Math.trunc(Number(cfg.returnQty || 0))))
            : 0;
          if (used === 0 && ret === 0) continue;
          if (used + ret > line.pendingQty) {
            throw new Error(`Used + returned exceeds pending for ${line.variantName} in voucher ${issue.voucherNumber}.`);
          }
          (returnsByIssue[issue.issueId] ??= []).push({
            lineId: line.lineId, returnedQty: ret, consumedQty: used,
          });
        }
      }
      let matReturnTotal = 0;
      let matConsumedTotal = 0;
      for (const [issueId, lines] of Object.entries(returnsByIssue)) {
        await Api.materialIssues.recordReturn(Number(issueId), { lines });
        matReturnTotal += lines.reduce((s, l) => s + l.returnedQty, 0);
        matConsumedTotal += lines.reduce((s, l) => s + (l.consumedQty ?? 0), 0);
      }
      return { ...receipt, matReturnTotal, matConsumedTotal };
    },
    onSuccess: (res: any) => {
      const parts: string[] = [];
      if (res.matReturnTotal > 0) parts.push(`${res.matReturnTotal} pcs returned to stock`);
      if (res.matConsumedTotal > 0) parts.push(`${res.matConsumedTotal} pcs written off as used`);
      toast.success(
        parts.length
          ? `Receipt ${res.receiptNumber} recorded — ${parts.join(', ')}.`
          : `Receipt ${res.receiptNumber} recorded.`,
      );
      // Invalidate EVERY query that depends on the receipt state — including the
      // pending list keyed by batch+vendor. Without this, reopening the dialog
      // shows stale "still pending" items and the user double-saves.
      //
      // material-issues + vendor-holdings + material-issue MUST refresh because
      // "Used" is gated on sticking pieces received: every receipt may bump up
      // the consumed materials for the linked sticking voucher.
      qc.invalidateQueries({ queryKey: ['casting-receipts'] });
      qc.invalidateQueries({ queryKey: ['casting-batches'] });
      qc.invalidateQueries({ queryKey: ['casting-batch'] });
      qc.invalidateQueries({ queryKey: ['casting-pending'] });
      qc.invalidateQueries({ queryKey: ['produced'] });
      qc.invalidateQueries({ queryKey: ['material-issues'] });
      qc.invalidateQueries({ queryKey: ['material-issue'] });
      qc.invalidateQueries({ queryKey: ['vendor-holdings'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
      qc.invalidateQueries({ queryKey: ['stock-movements'] });
      qc.invalidateQueries({ queryKey: ['variants'] });
      submittingRef.current = false;
      onClose();
    },
    onError: (e) => {
      submittingRef.current = false;
      toast.error(e instanceof Error && !(e as any).response ? e.message : getApiError(e).message);
    },
  });
  const submit = () => {
    if (submittingRef.current || create.isPending) return; // already in flight
    submittingRef.current = true;
    create.mutate();
  };

  const vendors = batchQ.data?.vendors ?? [];

  return (
    <Dialog open={open} onClose={onClose} size="xl"
      title="Receive Goods"
      description="Receive one process at a time. Partial & multiple receipts per stage are supported."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={create.isPending || !batchId || !vendorId}>
            {create.isPending && <Spinner />} {create.isPending ? 'Saving…' : 'Save Receipt'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-5">
          <Field label="Batch">
            <SearchableSelect
              value={batchId}
              placeholder="— Select batch —"
              onChange={(v) => { setBatchId(v ? Number(v) : ''); setVendorId(''); }}
              options={(batchesQ.data ?? []).map((b: any) => ({ value: b.id, label: b.batchNumber }))}
            />
          </Field>
          <Field label="Vendor" hint="Vendors that have fully delivered are not listed.">
            <SearchableSelect
              value={vendorId}
              placeholder="— Select vendor —"
              disabled={!batchId}
              onChange={(v) => setVendorId(v ? Number(v) : '')}
              options={vendors.filter((v: any) => !v.completed).map((v: any) => ({
                value: v.id,
                label: `${v.vendorCode} · ${v.vendorName}`,
                keywords: v.vendorName,
              }))}
            />
          </Field>
          <Field label="Process" hint="One receipt = one process.">
            <SearchableSelect
              value={stageProcessId}
              placeholder="—"
              disabled={!vendorId || processesInList.length === 0}
              onChange={(v) => setStageProcessId(v ? Number(v) : '')}
              options={processesInList.map((p) => ({ value: p.id, label: p.name }))}
            />
          </Field>
          <Field label="Receipt Date"><Input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} /></Field>
          <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>

        {batchId && vendorId && (
          <div>
            <SectionTitle>Items to Receive</SectionTitle>
            {pendingQ.isLoading ? (
              <div className="flex justify-center py-6"><Spinner className="text-primary" /></div>
            ) : visibleItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing pending for this vendor / process.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-slate-600">
                    <tr>
                      <th className="px-2 py-2">Item #</th>
                      <th className="px-2 py-2">Process</th>
                      <th className="px-2 py-2">Vendor Ref</th>
                      <th className="px-2 py-2">Colour</th>
                      <th className="px-2 py-2">Ord. Qty</th>
                      <th className="px-2 py-2">Ord. Wt</th>
                      <th className="px-2 py-2">Recd-so-far</th>
                      <th className="px-2 py-2">Pending</th>
                      <th className="px-2 py-2">Recv Qty</th>
                      <th className="px-2 py-2">Recv Wt</th>
                      <th className="px-2 py-2">Excess/Short</th>
                      <th className="px-2 py-2">Remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.map((it: any) => {
                      const recvNow = Number(inputs[it.id]?.receivedQty || 0);
                      const excessShort = it.receivedQty + recvNow - it.quantity;
                      return (
                        <tr key={it.id} className="border-t border-border">
                          <td className="px-2 py-1.5 font-semibold text-primary">{it.itemNumber ? `#${it.itemNumber}` : '—'}</td>
                          <td className="px-2 py-1.5"><Badge variant="default">{it.processName}</Badge></td>
                          <td className="px-2 py-1.5 font-medium">{it.vendorDesignReference || '—'}</td>
                          <td className="px-2 py-1.5">{it.color || '—'}</td>
                          <td className="px-2 py-1.5">{it.quantity}</td>
                          <td className="px-2 py-1.5">{it.totalWeight}</td>
                          <td className="px-2 py-1.5">{it.receivedQty}</td>
                          <td className="px-2 py-1.5"><span className={it.pendingQty > 0 ? 'text-amber-600' : 'text-emerald-600'}>{it.pendingQty}</span></td>
                          <td className="px-2 py-1.5">
                            <Input type="number" className="h-8 w-20" value={inputs[it.id]?.receivedQty ?? ''}
                              onChange={(e) => {
                                const q = e.target.value;
                                // Auto-update received weight proportionally (qty × per-piece weight).
                                const w = Number(q || 0) * Number(it.weight || 0);
                                setInput(it.id, { receivedQty: q, receivedWeight: w ? String(w) : '' });
                              }} />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input type="number" step="0.001" className="h-8 w-24" value={inputs[it.id]?.receivedWeight ?? ''} onChange={(e) => setInput(it.id, { receivedWeight: e.target.value })} />
                          </td>
                          <td className="px-2 py-1.5">
                            <span className={excessShort === 0 ? 'text-muted-foreground' : excessShort > 0 ? 'text-sky-600 font-medium' : 'text-red-600 font-medium'}>
                              {excessShort > 0 ? `+${excessShort}` : excessShort}
                            </span>
                          </td>
                          <td className="px-2 py-1.5">
                            <Input className="h-8" value={inputs[it.id]?.remarks ?? ''} onChange={(e) => setInput(it.id, { remarks: e.target.value })} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Received quantity is never assumed equal to ordered — short/excess is tracked for inventory settlement.
            </p>

            {/* Sticking receipts ALWAYS prompt about materials so the user has
                a clear yes/no answer recorded. Three scenarios per stage:
                  (a) Voucher with pending materials → ask "returning or keeping?"
                  (b) Voucher fully cleared / all used → green confirmation banner
                  (c) No voucher at all (bringsOwnMaterials, or no BOM) → grey info banner */}
            {visibleItems.some((it: any) => it.processCode === 'STICKING') && (
              <div className="mt-4 space-y-3">
                <SectionTitle>Material Return from Vendor</SectionTitle>
                <p className="text-xs text-muted-foreground">
                  For every sticking stage being received, confirm what's happening to the issued materials —
                  vendor returning extras, vendor keeping them, or no materials were involved.
                </p>
                {visibleItems.filter((it: any) => it.processCode === 'STICKING').map((it: any) => {
                  const issue = it.materialIssue;
                  const headerLabel = `${it.vendorDesignReference || it.itemNumber}${it.color ? ` (${it.color})` : ''}`;

                  // Case (c): no linked voucher → vendor brought own materials or no BOM.
                  if (!issue) {
                    return (
                      <div key={`mr-${it.id}`} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                        <div className="font-semibold">{headerLabel}</div>
                        <div className="text-xs">No material voucher linked — vendor used their own raw materials, or no BOM was configured. Nothing to record.</div>
                      </div>
                    );
                  }

                  // Case (b): voucher exists but pending is 0 → all materials accounted for.
                  if (!issue.lines?.length) {
                    return (
                      <div key={`mr-${it.id}`} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                        <div className="font-semibold">Voucher {issue.voucherNumber} · {headerLabel}</div>
                        <div className="text-xs">All materials accounted for — nothing pending with vendor. ✓</div>
                      </div>
                    );
                  }

                  // Case (a): pending lines → for each material, two questions:
                  //   Q1. How much was actually USED? (auto-defaults to
                  //       perPiece × sticking pcs received NOW; editable so
                  //       waste / extra usage can be recorded).
                  //   Q2. The EXCESS (= pending − used). Is the vendor
                  //       returning it now, or keeping it for later?
                  //
                  // This mirrors how materials were issued: the system already
                  // computes BOM × stage qty for the auto-issue — we now ask
                  // the same question at receive time but adjusted for the
                  // pieces actually received back.
                  const stickingReceivedNow = Math.max(0, Math.trunc(Number(inputs[it.id]?.receivedQty || 0)));
                  const rowReturns: MatReturnInput = matReturns[it.id] ?? {};
                  const defaultRow = (line: any): MatReturnRow => ({
                    used: String(Math.max(0, Math.min(line.pendingQty, (line.perPiece ?? 0) * stickingReceivedNow))),
                    excessMode: 'keep',
                    returnQty: '',
                  });
                  const cfgFor = (line: any): MatReturnRow => rowReturns[line.lineId] ?? defaultRow(line);
                  const setRow = (lineId: number, patch: Partial<MatReturnRow>) => {
                    const line = issue.lines.find((l: any) => l.lineId === lineId);
                    const base = rowReturns[lineId] ?? (line ? defaultRow(line) : { used: '0', excessMode: 'keep', returnQty: '' });
                    setMatReturns((m) => ({
                      ...m,
                      [it.id]: { ...(m[it.id] ?? {}), [lineId]: { ...base, ...patch } },
                    }));
                  };
                  // Voucher totals for the bottom summary.
                  const lineTotals = issue.lines.reduce((acc: any, line: any) => {
                    const cfg = cfgFor(line);
                    const used = Math.max(0, Math.trunc(Number(cfg.used || 0)));
                    const excess = Math.max(0, line.pendingQty - used);
                    const ret = cfg.excessMode === 'return'
                      ? Math.min(excess, Math.max(0, Math.trunc(Number(cfg.returnQty || 0))))
                      : 0;
                    const kept = excess - ret;
                    return { used: acc.used + used, ret: acc.ret + ret, kept: acc.kept + kept };
                  }, { used: 0, ret: 0, kept: 0 });

                  return (
                    <div key={`mr-${it.id}`} className="overflow-hidden rounded-lg border border-amber-200 bg-amber-50/40">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs">
                        <span className="font-semibold text-amber-900">
                          Voucher {issue.voucherNumber} · {headerLabel} · <span className="font-normal">{stickingReceivedNow} pcs being received</span>
                        </span>
                      </div>
                      <table className="w-full text-sm">
                        <thead className="bg-amber-50/30 text-left text-xs text-amber-900">
                          <tr>
                            <th className="px-3 py-2">Material</th>
                            <th className="px-3 py-2 text-right">With vendor</th>
                            <th className="px-3 py-2 text-right" title="Auto-calculated from BOM × sticking pcs received now. Edit if vendor used more/less.">Used? (auto)</th>
                            <th className="px-3 py-2 text-right">Excess</th>
                            <th className="px-3 py-2">Excess: return or keep?</th>
                            <th className="px-3 py-2 text-right">Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {issue.lines.map((line: any) => {
                            const cfg = cfgFor(line);
                            const autoUsed = Math.max(0, Math.min(line.pendingQty, (line.perPiece ?? 0) * stickingReceivedNow));
                            const used = Math.max(0, Math.trunc(Number(cfg.used || 0)));
                            const excess = Math.max(0, line.pendingQty - used);
                            const isReturn = cfg.excessMode === 'return';
                            const ret = isReturn
                              ? Math.min(excess, Math.max(0, Math.trunc(Number(cfg.returnQty || 0))))
                              : 0;
                            const kept = excess - ret;
                            const usedOver = used > line.pendingQty;
                            const retOver = ret > excess;
                            return (
                              <tr key={line.lineId} className="border-t border-amber-100">
                                <td className="px-3 py-2 align-top">
                                  <div className="font-medium text-foreground">{line.variantName}</div>
                                  <div className="text-[10px] text-muted-foreground">
                                    {line.variantCode}{line.unit ? ` · ${line.unit}` : ''}
                                    {line.perPiece > 0 && ` · ${line.perPiece}/pc`}
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right align-top">
                                  <div className="font-semibold text-amber-700 tabular-nums">{line.pendingQty}</div>
                                  <div className="text-[10px] text-muted-foreground">pcs</div>
                                </td>
                                <td className="px-3 py-2 text-right align-top">
                                  <Input type="number" min={0} max={line.pendingQty} step="1"
                                    className={`h-8 w-24 text-right font-medium ${usedOver ? 'border-red-300 bg-red-50' : ''}`}
                                    value={cfg.used ?? ''}
                                    onChange={(e) => setRow(line.lineId, { used: e.target.value.replace(/[^0-9]/g, '') })}
                                  />
                                  <div className="text-[10px] text-muted-foreground">
                                    auto: {autoUsed}
                                  </div>
                                  {usedOver && <div className="text-[10px] text-red-600">exceeds pending</div>}
                                </td>
                                <td className="px-3 py-2 text-right align-top">
                                  <div className="font-semibold text-foreground tabular-nums">{excess}</div>
                                  <div className="text-[10px] text-muted-foreground">left over</div>
                                </td>
                                <td className="px-3 py-2 align-top">
                                  {excess === 0 ? (
                                    <span className="text-[11px] text-muted-foreground">— no excess —</span>
                                  ) : (
                                    <div className="inline-flex flex-wrap items-center gap-2">
                                      <button type="button"
                                        onClick={() => setRow(line.lineId, { excessMode: 'keep', returnQty: '' })}
                                        className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                                          !isReturn
                                            ? 'border-slate-400 bg-slate-100 text-slate-800'
                                            : 'border-transparent text-slate-600 hover:bg-slate-100'
                                        }`}>
                                        ✋ Vendor keeping
                                      </button>
                                      <button type="button"
                                        onClick={() => setRow(line.lineId, { excessMode: 'return', returnQty: String(excess) })}
                                        className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                                          isReturn
                                            ? 'border-emerald-400 bg-emerald-100 text-emerald-800'
                                            : 'border-transparent text-emerald-700 hover:bg-emerald-100'
                                        }`}>
                                        🔄 Vendor returning
                                      </button>
                                      {isReturn && (
                                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-800">
                                          <Input type="number" min={0} max={excess} step="1"
                                            className={`h-7 w-20 text-right ${retOver ? 'border-red-300 bg-red-50' : ''}`}
                                            value={cfg.returnQty ?? ''}
                                            onChange={(e) => setRow(line.lineId, { returnQty: e.target.value.replace(/[^0-9]/g, '') })}
                                          />
                                          <span className="text-[10px] text-muted-foreground">/ {excess}</span>
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right align-top text-xs">
                                  <div className="space-y-0.5">
                                    {used > 0 && (
                                      <div className="text-sky-700 tabular-nums">{used} used</div>
                                    )}
                                    {ret > 0 && (
                                      <div className="text-emerald-700 tabular-nums">Stock +{ret}</div>
                                    )}
                                    {kept > 0 && (
                                      <div className="text-amber-700 tabular-nums">{kept} stays with vendor</div>
                                    )}
                                    {used === 0 && ret === 0 && kept === 0 && (
                                      <div className="text-muted-foreground">—</div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="border-t border-amber-200 bg-amber-50/60">
                            <td colSpan={5} className="px-3 py-1.5 text-xs font-semibold text-amber-900">Voucher total</td>
                            <td className="px-3 py-1.5 text-right text-xs">
                              <span className="text-sky-700 font-semibold">{lineTotals.used} used</span>
                              {' · '}
                              <span className="text-emerald-700 font-semibold">+{lineTotals.ret} returned</span>
                              {' · '}
                              <span className="text-amber-700 font-semibold">{lineTotals.kept} kept</span>
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
