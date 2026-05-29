'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, AlertTriangle, PackageSearch } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Field, SectionTitle } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';
import { formatCurrency } from '@/lib/utils';
import type { ItemMeta, Item } from '@/lib/types';

// A production batch always STARTS at Casting. Each row = one design to cast.
// Colours are chosen later, per process step (Plating/Meena/…), not here.
interface Row {
  itemId?: number;
  quantity: string;
  vendorId?: number | '';
  weight?: string;
  costPerKg?: string;
  totalWeight?: string;
  remarks: string;
  // Pending settle ops carried over from the "existing stock" dialog; applied
  // AFTER batch creation so the absorbed pieces live in the NEW batch.
  pendingSettles?: PendingSettle[];
  // Pending planned-forwards for AT-VENDOR stages — registered with the
  // backend after batch creation so receipts later auto-route into the new batch.
  pendingPlans?: PendingPlan[];
}
const emptyRow = (): Row => ({ quantity: '', remarks: '' });

// Settle operation captured from the dialog and applied AFTER the new batch is
// created — so the resulting child stage lives in the NEW batch (not the old,
// often-short-closed one) and shows up alongside the freshly cast pieces.
type PendingSettle = {
  stageIds: number[];
  nextProcessId: number;
  color?: string;
  vendorId?: number;
  maxQty: number;
  // For the UI summary on the row strip.
  fromProcessName: string;
  toProcessName: string;
};

// Planned forward registered on AT-VENDOR stages — applied automatically by the
// backend when the stage is later received via Receive Goods. Lets the new-batch
// dialog steer at-vendor pieces into the new batch the moment they come back.
// If `receiveNow=true`, the dialog also fires a receipt at batch-create time
// so the pieces land in the new batch immediately, not later.
type PendingPlan = {
  stageId: number;
  nextProcessId: number;
  vendorId?: number;
  color?: string;
  // For the UI summary on the row strip.
  fromProcessName: string;
  toProcessName: string;
  qty: number;
  // Receive-now: record the receipt at batch-create time.
  receiveNow: boolean;
  receiveQty: number;
  sourceBatchId: number;
  sourceVendorId: number;
  perPieceWeight: number;
};

/**
 * Dialog shown when the user selects a design that already has produced/in-process
 * stock. Three strategies the user can pick:
 *   1. Use existing only — zeroes this row's cast qty.
 *   2. Use existing + cast more — settles the lots they tick, the row keeps its
 *      target qty (so casting is created for the rest).
 *   3. Use part of existing — settles only N of the available in-house pieces;
 *      the rest stay in stock and the row's cast qty is recalculated.
 *
 * For every IN-HOUSE lot the user can configure WHERE those pieces go (next
 * process, vendor, colour). Lots already with vendors / packed aren't touched.
 */
type Strategy = 'only' | 'add' | 'partial';
function SettleExistingStockDialog({
  open, onClose, design, lots, summary, initialTargetQty, meta, onApplied,
}: {
  open: boolean;
  onClose: () => void;
  design: { itemId: number; itemNumber?: string | null; designCode: string; itemName?: string | null };
  // All "rows" from produced (FINISHED + IN_HOUSE + AT_VENDOR) for this design.
  lots: any[];
  summary: { finished: number; inHouse: number; atVendor: number };
  initialTargetQty: number; // pre-fill from the row, but editable inside the dialog
  meta: ItemMeta;
  // newCastQty < targetQty after settling; the parent updates the row + holds
  // the pending settles + plans to fire AFTER the new batch is created. Settles
  // are immediate forwards; plans are pre-registered on at-vendor stages so the
  // backend auto-forwards them when they're received.
  onApplied: (newCastQty: number, settles: PendingSettle[], plans: PendingPlan[]) => void;
}) {
  const inHouseLots = React.useMemo(() => lots.filter((l) => l.state === 'IN_HOUSE'), [lots]);
  const atVendorLots = React.useMemo(() => lots.filter((l) => l.state === 'AT_VENDOR'), [lots]);
  const finishedQty = summary.finished;
  const atVendorQty = summary.atVendor;
  // The user types the ORDER TARGET inside the dialog — this is the source of
  // truth for all "should we cast more?" math. Pre-filled from the row if any.
  const [targetInput, setTargetInput] = React.useState('');
  // Per-lot settle config: { settle: bool, qty, processId, vendorId, color }
  type Cfg = { enabled: boolean; qty: string; processId: number | ''; vendorId: number | ''; color: string };
  const [cfg, setCfg] = React.useState<Record<number, Cfg>>({});
  // Per AT-VENDOR-lot planned-forward config — applied to the backend as a
  // "planned forward" on the source stage, so when received it auto-routes.
  // `receiveNow=true` ALSO creates a receipt against the source batch at create
  // time, marking those pieces as physically returned now (the plan-based
  // auto-forward fires automatically in createReceipt and lands them in the
  // new batch — everything in one batch, exactly as the user wanted).
  type AvCfg = {
    enabled: boolean;
    processId: number | '';
    vendorId: number | '';
    color: string;
    receiveNow: boolean;
    receiveQty: string;
  };
  const [avCfg, setAvCfg] = React.useState<Record<number, AvCfg>>({});
  const [strategy, setStrategy] = React.useState<Strategy>('add');

  // Initialise per-lot config + target input when the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    const next: Record<number, Cfg> = {};
    inHouseLots.forEach((lot, i) => {
      next[i] = {
        enabled: true,
        qty: String(lot.qty),
        processId: lot.nextProcessId ?? '',
        vendorId: '', // auto by colour on the server when blank
        color: lot.nextUsesColor && lot.nextColorOptions?.length ? lot.nextColorOptions[0] : '',
      };
    });
    setCfg(next);
    const nextAv: Record<number, AvCfg> = {};
    atVendorLots.forEach((lot, i) => {
      nextAv[i] = {
        enabled: true,
        processId: lot.nextProcessId ?? '',
        vendorId: '',
        color: lot.nextUsesColor && lot.nextColorOptions?.length ? lot.nextColorOptions[0] : '',
        receiveNow: false,
        receiveQty: String(lot.qty),
      };
    });
    setAvCfg(nextAv);
    setStrategy('add');
    setTargetInput(initialTargetQty > 0 ? String(initialTargetQty) : '');
  }, [open, inHouseLots.length, atVendorLots.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Available processes (excluding CASTING + DESIGN_CAD) for the "send to" choice.
  const processes = (meta.processes ?? []).filter((p) => p.code !== 'DESIGN_CAD' && p.code !== 'CASTING');

  const targetQty = Math.max(0, Math.trunc(Number(targetInput || 0)));
  // Pieces the user actually plans to settle (sum across enabled lots).
  const totalSettling = inHouseLots.reduce((sum, _lot, i) => {
    const c = cfg[i]; if (!c?.enabled) return sum;
    return sum + Math.max(0, Math.trunc(Number(c.qty || 0)));
  }, 0);
  // Combined "we already have" — packed (ready now) + in-house being settled +
  // pieces already at a vendor doing some step. The at-vendor pieces are ALREADY
  // cast and progressing; they'll come back via Receive Goods and continue from
  // wherever they are. So they DO count toward fulfilling the new order and we
  // should NOT re-cast them. (Pessimists can flip to "Cast new only".)
  const alreadyHave = finishedQty + totalSettling + atVendorQty;
  // Strategy-specific recommended cast qty.
  const recommendedCastQty =
    strategy === 'only' ? 0
    : strategy === 'add' ? targetQty
    : Math.max(0, targetQty - alreadyHave);
  const canApply = targetQty > 0 || strategy === 'only';

  // "Cast new only" leaves existing pieces alone — no settles fire. The other
  // two strategies BOTH settle the enabled lots; they only differ in how many
  // new pieces to cast on top.
  const settlesEnabled = strategy !== 'add';

  // Apply is synchronous now: just bundle up the settle + plan configs and hand
  // them to the parent. The actual API calls fire AFTER the batch is created so
  // settled pieces land in the new batch (with `targetBatchId`), and at-vendor
  // plans get registered so receipts auto-route into the new batch.
  const apply = {
    isPending: false,
    mutate: () => {
      try {
        const settles: PendingSettle[] = [];
        const plans: PendingPlan[] = [];
        if (settlesEnabled) {
          for (let i = 0; i < inHouseLots.length; i++) {
            const lot = inHouseLots[i];
            const c = cfg[i];
            if (!c?.enabled) continue;
            const askQty = Math.max(0, Math.trunc(Number(c.qty || 0)));
            if (askQty <= 0) continue;
            if (!c.processId) {
              toast.error(`Choose a next process for the ${lot.processName} lot.`);
              return;
            }
            const target = processes.find((p) => p.id === Number(c.processId));
            const usesColor = !!target && lot.nextUsesColor;
            settles.push({
              stageIds: lot.stages.map((s: any) => s.id),
              nextProcessId: Number(c.processId),
              color: usesColor && c.color ? c.color : undefined,
              vendorId: c.vendorId ? Number(c.vendorId) : undefined,
              maxQty: askQty,
              fromProcessName: lot.processName,
              toProcessName: target?.name ?? '—',
            });
          }
          // At-vendor plans — one per stage in each enabled at-vendor lot.
          // Receive-now qty is split across the lot's stages proportionally so
          // multi-stage lots distribute correctly (most lots = 1 stage anyway).
          for (let i = 0; i < atVendorLots.length; i++) {
            const lot = atVendorLots[i];
            const a = avCfg[i];
            if (!a?.enabled) continue;
            if (!a.processId) {
              toast.error(`Choose a next process for the at-vendor ${lot.processName} lot.`);
              return;
            }
            const target = processes.find((p) => p.id === Number(a.processId));
            const usesColor = !!target && lot.nextUsesColor;
            const stages = (lot.stages ?? []) as { id: number; idle: number; batchId: number; perPieceWeight: number }[];
            const totalIdle = stages.reduce((s, x) => s + x.idle, 0);
            const wantReceive = a.receiveNow ? Math.min(Math.max(0, Math.trunc(Number(a.receiveQty || 0))), totalIdle) : 0;
            let remaining = wantReceive;
            stages.forEach((s, idx) => {
              const isLast = idx === stages.length - 1;
              const myReceive = a.receiveNow
                ? (isLast ? remaining : Math.floor(wantReceive * (s.idle / totalIdle)))
                : 0;
              remaining -= myReceive;
              plans.push({
                stageId: s.id,
                nextProcessId: Number(a.processId),
                vendorId: a.vendorId ? Number(a.vendorId) : undefined,
                color: usesColor && a.color ? a.color : undefined,
                fromProcessName: lot.processName,
                toProcessName: target?.name ?? '—',
                qty: s.idle,
                receiveNow: a.receiveNow,
                receiveQty: Math.max(0, myReceive),
                sourceBatchId: s.batchId,
                sourceVendorId: lot.vendorId,
                perPieceWeight: s.perPieceWeight,
              });
            });
          }
        }
        onApplied(recommendedCastQty, settles, plans);
        const settleQty = settles.reduce((s, x) => s + x.maxQty, 0);
        const planQty = plans.reduce((s, x) => s + x.qty, 0);
        toast.success(
          settleQty + planQty > 0
            ? `Plan saved — ${settleQty} pcs absorbed now, ${planQty} pcs auto-route into the new batch when received.`
            : 'Cast qty updated.',
        );
        onClose();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to plan settles.');
      }
    },
  };

  const designLabel = `${design.itemNumber ? `#${design.itemNumber} · ` : ''}${design.designCode}${design.itemName ? ` — ${design.itemName}` : ''}`;

  return (
    <Dialog open={open} onClose={onClose} size="xl"
      title="Existing stock found"
      description={designLabel}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={apply.isPending}>Cancel</Button>
          <Button onClick={() => apply.mutate()} disabled={apply.isPending || !canApply}>
            {apply.isPending && <Spinner />} Apply &amp; set cast qty to {recommendedCastQty}
          </Button>
        </>
      }>
      <div className="space-y-4">
        {/* Plain-English alert at the top so the user understands WHY this dialog popped up. */}
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>Heads up —</strong> this design already exists in your system:
          {summary.finished > 0 && <> <strong>{summary.finished}</strong> packed &amp; ready,</>}
          {summary.inHouse > 0 && <> <strong>{summary.inHouse}</strong> half-done in stock,</>}
          {summary.atVendor > 0 && <> <strong>{summary.atVendor}</strong> already at a vendor (no re-casting needed).</>}
          {' '}Tell us your new order target and how you'd like to fulfil it.
        </div>

        {/* Summary chips */}
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-emerald-800">
            ✓ {summary.finished} packed &amp; ready
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-amber-800">
            🏭 {summary.inHouse} half-done in stock
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-sky-300 bg-sky-50 px-3 py-1 text-sky-800">
            🚚 {summary.atVendor} at vendor
          </span>
        </div>

        {/* The order target — collected here so all strategy math is meaningful. */}
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm font-semibold text-foreground">New order target</label>
            <Input
              type="number" min="0" step="1" className="h-9 w-32 text-right text-base font-semibold"
              placeholder="how many pcs?"
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value.replace(/[^0-9]/g, ''))}
              autoFocus
            />
            <span className="text-sm text-muted-foreground">pieces needed for this order</span>
          </div>
          {targetQty === 0 && (
            <p className="mt-1.5 text-xs text-amber-700">Enter the order qty so we can suggest how many to cast new.</p>
          )}
        </div>

        {/* Strategy radios — disabled when target is 0 (except "use only" which is always valid). */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <StrategyCard checked={strategy === 'only'} onClick={() => setStrategy('only')}
            title="Use existing only"
            body={`Cast nothing new — fulfil from the ${alreadyHave} pcs already in your system (packed + half-done + at vendor).`} />
          <StrategyCard checked={strategy === 'add'} onClick={() => targetQty > 0 && setStrategy('add')}
            disabled={targetQty === 0}
            title="Cast new only"
            body={targetQty > 0
              ? `Ignore existing stock — cast ${targetQty} fresh pieces. Existing pieces continue on their own track.`
              : 'Enter an order qty first.'} />
          <StrategyCard checked={strategy === 'partial'} onClick={() => targetQty > 0 && setStrategy('partial')}
            disabled={targetQty === 0}
            title="Use existing + cast shortfall"
            body={targetQty > 0
              ? `Cast only ${Math.max(0, targetQty - alreadyHave)} more — the ${alreadyHave} existing pcs cover the rest.`
              : 'Enter an order qty first.'} />
        </div>

        {/* In-house lots — per-lot settle config. Dimmed when strategy = "add". */}
        {inHouseLots.length === 0 ? (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            No in-process lots to continue. (Packed &amp; at-vendor pieces are tracked separately.)
          </p>
        ) : (
          <div className={`overflow-hidden rounded-lg border border-border ${settlesEnabled ? '' : 'opacity-50'}`}>
            <div className="border-b border-border bg-muted/50 px-3 py-1.5 text-xs font-semibold text-muted-foreground">
              {settlesEnabled
                ? 'In-process lots — choose where each settled piece goes'
                : 'In-process lots — not used in "Cast new only" mode'}
            </div>
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5"></th>
                  <th className="px-2 py-1.5">Lot</th>
                  <th className="px-2 py-1.5 text-right">Settle qty</th>
                  <th className="px-2 py-1.5">Next process</th>
                  <th className="px-2 py-1.5">Vendor</th>
                  <th className="px-2 py-1.5">Colour</th>
                </tr>
              </thead>
              <tbody>
                {inHouseLots.map((lot, i) => {
                  const c = cfg[i] ?? { enabled: true, qty: String(lot.qty), processId: lot.nextProcessId ?? '', vendorId: '', color: '' };
                  const targetProc = processes.find((p) => p.id === Number(c.processId));
                  const procVendors = targetProc?.vendors ?? [];
                  const colourOpts: string[] = lot.nextColorOptions ?? [];
                  // Hide processes already done for THIS lot — meta `processes` is sorted
                  // by workflow order, so anything at-or-before the lot's current process
                  // index is already finished and shouldn't be a "next step" option.
                  // (CASTING is filtered out of `processes` entirely → idx -1 means show all.)
                  const lotProcIdx = processes.findIndex((p) => p.code === lot.processCode);
                  const nextProcessOpts = lotProcIdx >= 0 ? processes.slice(lotProcIdx + 1) : processes;
                  return (
                    <tr key={i} className="border-t border-border align-top">
                      <td className="px-2 py-1.5">
                        <input type="checkbox" className="mt-1 size-4 accent-primary"
                          disabled={!settlesEnabled}
                          checked={c.enabled && settlesEnabled}
                          onChange={(e) => setCfg((m) => ({ ...m, [i]: { ...c, enabled: e.target.checked } }))} />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="font-medium text-foreground">{lot.qty} pcs · {lot.processName} done</div>
                        <div className="text-xs text-muted-foreground">
                          at {lot.vendorCode ? `${lot.vendorCode} · ${lot.vendorName}` : '—'}{lot.color ? ` (${lot.color})` : ''}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Input type="number" min={0} max={lot.qty} className="h-7 w-20 text-right"
                          disabled={!settlesEnabled || !c.enabled}
                          value={c.qty}
                          onChange={(e) => setCfg((m) => ({ ...m, [i]: { ...c, qty: e.target.value.replace(/[^0-9]/g, '') } }))} />
                        <div className="text-[10px] text-muted-foreground">max {lot.qty}</div>
                      </td>
                      <td className="px-2 py-1.5">
                        <Select value={c.processId}
                          disabled={!settlesEnabled || !c.enabled}
                          onChange={(e) => setCfg((m) => ({ ...m, [i]: { ...c, processId: e.target.value ? Number(e.target.value) : '', vendorId: '' } }))}>
                          <option value="">— Select —</option>
                          {nextProcessOpts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </Select>
                      </td>
                      <td className="px-2 py-1.5">
                        <SearchableSelect
                          value={c.vendorId}
                          disabled={!settlesEnabled || !c.enabled || !c.processId}
                          placeholder={c.processId ? 'auto by colour' : 'pick process first'}
                          onChange={(v) => setCfg((m) => ({ ...m, [i]: { ...c, vendorId: v ? Number(v) : '' } }))}
                          // Only vendors registered for the SELECTED next process — no fallback
                          // to "all vendors" so the dropdown stays scoped to who can actually do
                          // that step. If empty, user knows no vendor handles this process.
                          options={procVendors.map((v: any) => ({
                            value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName,
                          }))}
                        />
                        {c.processId && procVendors.length === 0 && (
                          <div className="text-[10px] text-amber-700">No vendor configured for this process — auto-pick will fail.</div>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {colourOpts.length > 0 ? (
                          <Select value={c.color}
                            disabled={!settlesEnabled || !c.enabled}
                            onChange={(e) => setCfg((m) => ({ ...m, [i]: { ...c, color: e.target.value } }))}>
                            {colourOpts.map((co) => <option key={co} value={co}>{co}</option>)}
                          </Select>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* At-vendor lots — now ACTIONABLE via "planned forward". The user picks
            where these pieces go AFTER they're received, and the backend
            auto-forwards them into the new batch the moment a receipt is made.
            Dimmed when strategy = "Cast new only" (planning doesn't apply). */}
        {atVendorLots.length > 0 && (
          <div className={`overflow-hidden rounded-lg border border-sky-200 ${settlesEnabled ? '' : 'opacity-50'}`}>
            <div className="border-b border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-900">
              {settlesEnabled
                ? 'At-vendor lots — pre-plan next step · auto-routes into the new batch on receipt'
                : 'At-vendor lots — not pre-planned in "Cast new only" mode'}
            </div>
            <table className="w-full text-sm">
              <thead className="bg-sky-50/50 text-left text-xs text-sky-800">
                <tr>
                  <th className="px-2 py-1.5"></th>
                  <th className="px-2 py-1.5">Lot</th>
                  <th className="px-2 py-1.5">When received, send to</th>
                  <th className="px-2 py-1.5">Vendor</th>
                  <th className="px-2 py-1.5">Colour</th>
                </tr>
              </thead>
              <tbody>
                {atVendorLots.map((lot, i) => {
                  const a = avCfg[i] ?? { enabled: true, processId: lot.nextProcessId ?? '', vendorId: '', color: '' };
                  const target = processes.find((p) => p.id === Number(a.processId));
                  const procVendors = target?.vendors ?? [];
                  const colourOpts: string[] = lot.nextColorOptions ?? [];
                  // Filter to processes AFTER the lot's current process (no re-doing done steps).
                  const lotProcIdx = processes.findIndex((p) => p.code === lot.processCode);
                  const nextProcessOpts = lotProcIdx >= 0 ? processes.slice(lotProcIdx + 1) : processes;
                  return (
                    <React.Fragment key={`av-${i}`}>
                      <tr className="border-t border-sky-100 align-top">
                        <td className="px-2 py-1.5">
                          <input type="checkbox" className="mt-1 size-4 accent-primary"
                            disabled={!settlesEnabled}
                            checked={a.enabled && settlesEnabled}
                            onChange={(e) => setAvCfg((m) => ({ ...m, [i]: { ...a, enabled: e.target.checked } }))} />
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="font-medium text-foreground">{lot.qty} pcs · {lot.processName} at vendor</div>
                          <div className="text-xs text-muted-foreground">
                            {lot.vendorCode ? `${lot.vendorCode} · ${lot.vendorName}` : '—'}{lot.color ? ` (${lot.color})` : ''} · batch {(lot.batches || []).join(', ') || '—'}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <Select value={a.processId}
                            disabled={!settlesEnabled || !a.enabled}
                            onChange={(e) => setAvCfg((m) => ({ ...m, [i]: { ...a, processId: e.target.value ? Number(e.target.value) : '', vendorId: '' } }))}>
                            <option value="">— Select —</option>
                            {nextProcessOpts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </Select>
                        </td>
                        <td className="px-2 py-1.5">
                          <SearchableSelect
                            value={a.vendorId}
                            disabled={!settlesEnabled || !a.enabled || !a.processId}
                            placeholder={a.processId ? 'auto by colour' : 'pick process first'}
                            onChange={(v) => setAvCfg((m) => ({ ...m, [i]: { ...a, vendorId: v ? Number(v) : '' } }))}
                            options={procVendors.map((v: any) => ({
                              value: v.id ?? v.vendorId,
                              label: `${v.vendorCode} · ${v.vendorName}`,
                              keywords: v.vendorName,
                            }))}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          {colourOpts.length > 0 ? (
                            <Select value={a.color}
                              disabled={!settlesEnabled || !a.enabled}
                              onChange={(e) => setAvCfg((m) => ({ ...m, [i]: { ...a, color: e.target.value } }))}>
                              {colourOpts.map((co) => <option key={co} value={co}>{co}</option>)}
                            </Select>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                      {/* Receive-now toggle row — when checked, vendor returns are
                          recorded at batch-create time so the pieces land in the
                          new batch immediately (rather than waiting for Receive Goods). */}
                      <tr className="bg-sky-50/30">
                        <td></td>
                        <td colSpan={4} className="px-2 pb-2 pt-0">
                          <label className="inline-flex items-center gap-2 text-xs text-sky-900">
                            <input type="checkbox" className="size-3.5 accent-primary"
                              disabled={!settlesEnabled || !a.enabled}
                              checked={a.receiveNow}
                              onChange={(e) => setAvCfg((m) => ({ ...m, [i]: { ...a, receiveNow: e.target.checked } }))} />
                            Receive now — the vendor has returned these pieces, record receipt at batch-create time
                          </label>
                          {a.receiveNow && (
                            <div className="mt-1.5 flex items-center gap-2 text-xs text-sky-900">
                              <span className="text-sky-700">Qty received:</span>
                              <Input type="number" min={0} max={lot.qty} className="h-7 w-20 text-right"
                                value={a.receiveQty}
                                onChange={(e) => setAvCfg((m) => ({ ...m, [i]: { ...a, receiveQty: e.target.value.replace(/[^0-9]/g, '') } }))} />
                              <span className="text-sky-700">/ {lot.qty} at vendor</span>
                              <span className="text-sky-600">· will auto-forward into the new batch</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            <div className="border-t border-sky-200 bg-sky-50 px-3 py-1.5 text-[11px] text-sky-700">
              When the vendor returns these pieces, Receive Goods will auto-forward them to the planned next step + vendor — landing in this new batch alongside the freshly cast pieces.
            </div>
          </div>
        )}

        {/* Numbers preview — live summary of what's about to happen on Apply. */}
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-5">
            <div><span className="text-muted-foreground">Order target:</span> <strong>{targetQty}</strong></div>
            <div><span className="text-muted-foreground">Packed:</span> <strong>{summary.finished}</strong></div>
            <div><span className="text-muted-foreground">Settling now:</span> <strong>{settlesEnabled ? totalSettling : 0}</strong></div>
            <div><span className="text-muted-foreground">At vendor:</span> <strong>{atVendorQty}</strong></div>
            <div><span className="text-muted-foreground">→ Cast new:</span> <strong className="text-foreground">{recommendedCastQty}</strong></div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function StrategyCard({ checked, onClick, title, body, disabled = false }: { checked: boolean; onClick: () => void; title: string; body: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`text-left rounded-lg border p-3 transition-colors ${
        disabled ? 'cursor-not-allowed opacity-50 border-border'
        : checked ? 'border-primary bg-primary/5 ring-1 ring-primary'
        : 'border-border hover:bg-muted/40'
      }`}>
      <div className="flex items-center gap-2">
        <span className={`inline-block size-3.5 rounded-full border-2 ${checked ? 'border-primary bg-primary' : 'border-muted-foreground'}`} />
        <span className="font-semibold">{title}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </button>
  );
}

function CastingRow({
  row, castingProcessId, processVendors, allVendors, items, chosenItemIds, meta, onChange, onRemove,
}: {
  row: Row; castingProcessId: number;
  processVendors: { id: number; vendorCode: string; vendorName: string }[];
  allVendors: { id: number; vendorCode: string; vendorName: string }[];
  items: any[]; chosenItemIds: number[];
  meta: ItemMeta;
  onChange: (patch: Partial<Row>) => void; onRemove: () => void;
}) {
  const { data: item } = useQuery<Item>({
    queryKey: ['item', row.itemId], queryFn: () => Api.items.get(row.itemId!), enabled: !!row.itemId,
  });
  // Produced-goods alert: warn if this design already has finished/idle pieces
  // in stock. refetchOnFocus so re-entering the form picks up any inventory
  // changes from other tabs / actions (no stale "stock found" surprises).
  const { data: produced } = useQuery({
    queryKey: ['produced', row.itemId], queryFn: () => Api.casting.produced(row.itemId!),
    enabled: !!row.itemId,
    refetchOnWindowFocus: true,
    staleTime: 0, // always check freshness when this query is used
  });
  // Exclude SHORT-CLOSED batch lots from "existing stock" — those pieces are
  // frozen write-offs the user already accepted as lost; they're not free
  // inventory for a new order.
  const allLots = (produced?.rows ?? []).filter((r: any) => !r.batchClosed);
  const finishedQty = allLots.filter((r: any) => r.state === 'FINISHED').reduce((s: number, r: any) => s + r.qty, 0);
  const inHouseQty = allLots.filter((r: any) => r.state === 'IN_HOUSE').reduce((s: number, r: any) => s + r.qty, 0);
  const atVendorQty = allLots.filter((r: any) => r.state === 'AT_VENDOR').reduce((s: number, r: any) => s + r.qty, 0);
  const producedQty = finishedQty + inHouseQty + atVendorQty;
  // Only AUTO-OPEN the popup when we have ACTIONABLE stock — pieces in our
  // hands (packed + half-done idle). At-vendor counts as "in production",
  // not "stock", so it doesn't trigger the interrupt (the user can still
  // review them via the "Review existing stock" button if they want).
  const actionableQty = finishedQty + inHouseQty;

  // Settle dialog open/close. Auto-opens ONCE per design selection when
  // ACTIONABLE stock exists — at-vendor alone doesn't trigger the popup.
  const [settleOpen, setSettleOpen] = React.useState(false);
  const autoOpenedFor = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!row.itemId) { autoOpenedFor.current = null; return; }
    if (actionableQty > 0 && autoOpenedFor.current !== row.itemId) {
      autoOpenedFor.current = row.itemId;
      setSettleOpen(true);
    }
  }, [row.itemId, actionableQty]);
  const casting = item?.processes.find((p) => p.code === 'CASTING');
  const weight = casting ? Number(casting.attributes?.weight || 0) : 0;
  const entries = casting?.vendors ?? [];
  const preferred = entries.find((e) => e.isPreferred) ?? entries[0];
  // Show ALL vendors (preferred is auto-selected via effectiveVendor below).
  // Show ONLY vendors that handle the batch's process (Casting) — not every vendor.
  // The processVendors list comes from the item meta filtered to the casting process.
  const vendorList = processVendors;

  const effectiveVendor = (row.vendorId || preferred?.vendorId) ?? '';
  const chosenEntry = (effectiveVendor ? entries.find((e) => e.vendorId === Number(effectiveVendor)) : null) ?? preferred;
  const ref = chosenEntry?.vendorDesignReference ?? '';
  const resolvedRate = chosenEntry?.costPerPiece ?? null;
  const qty = Number(row.quantity || 0);

  const weightStr = row.weight ?? (weight ? String(weight) : '');
  const costStr = row.costPerKg ?? (resolvedRate != null ? String(resolvedRate) : '');
  const computedTotal = Number(weightStr || 0) * qty;
  const totalWeightStr = row.totalWeight ?? (computedTotal ? String(computedTotal) : '');
  const effTotalWeight = Number(totalWeightStr || 0);
  const totalCost = (effTotalWeight / 1000) * Number(costStr || 0); // casting is per KG

  // Designs already chosen in other rows are not selectable again in this batch.
  const selectableItems = items.filter((it) => it.id === row.itemId || !chosenItemIds.includes(it.id));

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      {row.itemId && producedQty > 0 && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-700" />
            <span>
              <strong>{producedQty} pcs</strong> of this design already exist
              {finishedQty > 0 && <> — <strong>{finishedQty}</strong> packed</>}
              {inHouseQty > 0 && <>, <strong>{inHouseQty}</strong> in-process</>}
              {atVendorQty > 0 && <>, <strong>{atVendorQty}</strong> at vendor</>}.
              Settle first — cast only the shortfall.
            </span>
          </div>
          <Button
            type="button" size="sm" variant="outline"
            className="h-7 border-amber-400 bg-white px-2 text-xs text-amber-900 hover:bg-amber-100"
            onClick={() => setSettleOpen(true)}
          >
            <PackageSearch className="size-3.5" /> Review existing stock
          </Button>
        </div>
      )}
      {row.itemId && item && (
        <SettleExistingStockDialog
          open={settleOpen}
          onClose={() => setSettleOpen(false)}
          design={{ itemId: row.itemId, itemNumber: item.itemNumber, designCode: item.sampleDesignCode, itemName: item.category ?? null }}
          lots={allLots}
          summary={{ finished: finishedQty, inHouse: inHouseQty, atVendor: atVendorQty }}
          initialTargetQty={Number(row.quantity || 0)}
          meta={meta}
          onApplied={(newQty, settles, plans) => onChange({ quantity: String(newQty), pendingSettles: settles, pendingPlans: plans })}
        />
      )}
      {row.pendingSettles && row.pendingSettles.length > 0 && (
        <div className="mb-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-900">
          <strong>Will absorb into this new batch:</strong>{' '}
          {row.pendingSettles.map((s, i) => (
            <span key={i}>
              {i > 0 && <>, </>}
              {s.maxQty} pcs from {s.fromProcessName} → {s.toProcessName}{s.color ? ` (${s.color})` : ''}
            </span>
          ))}
        </div>
      )}
      {row.pendingPlans && row.pendingPlans.length > 0 && (
        <div className="mb-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs text-sky-900">
          <strong>From at-vendor:</strong>{' '}
          {row.pendingPlans.map((p, i) => (
            <span key={i}>
              {i > 0 && <>, </>}
              {p.receiveNow && p.receiveQty > 0
                ? <>{p.receiveQty} pcs received now → {p.toProcessName}{p.color ? ` (${p.color})` : ''}</>
                : <>{p.qty} pcs · {p.fromProcessName} → {p.toProcessName}{p.color ? ` (${p.color})` : ''} (when vendor returns)</>}
            </span>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
        <div className="sm:col-span-4">
          <Field label="Design (Production Ready)">
            <SearchableSelect
              value={row.itemId ?? ''}
              placeholder="— Select design —"
              onChange={(v) => onChange({ itemId: v ? Number(v) : undefined, vendorId: '', weight: undefined, costPerKg: undefined, totalWeight: undefined })}
              options={selectableItems.map((it) => ({
                value: it.id,
                label: `${it.itemNumber != null ? `#${it.itemNumber} · ` : ''}${it.sampleDesignCode}`,
                keywords: `${it.category ?? ''} ${it.collection ?? ''} ${it.designerName ?? ''}`,
              }))}
            />
          </Field>
        </div>
        <div className="sm:col-span-3">
          <Field label="Casting Vendor (auto · editable)">
            <SearchableSelect
              value={effectiveVendor}
              placeholder="— Select —"
              onChange={(v) => onChange({ vendorId: v ? Number(v) : '' })}
              options={vendorList.map((v) => ({ value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName }))}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Total Qty"><Input type="number" value={row.quantity} onChange={(e) => onChange({ quantity: e.target.value })} /></Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Wt / pc (g)"><Input type="number" step="0.001" value={weightStr} onChange={(e) => onChange({ weight: e.target.value })} /></Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Cost / KG"><Input type="number" step="0.01" value={costStr} onChange={(e) => onChange({ costPerKg: e.target.value })} /></Field>
        </div>
        <div className="sm:col-span-3">
          <Field label="Total Weight (g) · editable"><Input type="number" step="0.001" value={totalWeightStr} onChange={(e) => onChange({ totalWeight: e.target.value })} /></Field>
        </div>
        <div className="sm:col-span-7">
          <Field label="Remarks"><Input value={row.remarks} onChange={(e) => onChange({ remarks: e.target.value })} /></Field>
        </div>
        <div className="sm:col-span-2 flex items-end">
          <Button type="button" variant="outline" size="icon" className="mb-0.5 text-destructive hover:bg-destructive/10" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>Vendor Ref: <strong className="text-foreground">{ref || '—'}</strong></span>
        <span>Total Wt: <strong className="text-foreground">{effTotalWeight ? effTotalWeight.toFixed(3) + ' g' : '—'}</strong></span>
        <span>Casting Cost: <strong className="text-foreground">{totalCost ? formatCurrency(totalCost) : '—'}</strong></span>
      </div>
    </div>
  );
}

export function BatchForm({
  open, onClose, onSaved, batchId,
}: {
  open: boolean; onClose: () => void; onSaved: (batchId: number) => void; batchId?: number | null;
}) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [batchNumber, setBatchNumber] = React.useState('');
  const [batchDate, setBatchDate] = React.useState(today);
  const [notes, setNotes] = React.useState('');
  const [rows, setRows] = React.useState<Row[]>([emptyRow()]);

  const metaQ = useQuery<ItemMeta>({ queryKey: ['item-meta'], queryFn: () => Api.items.meta(), enabled: open });
  const itemsQ = useQuery({
    queryKey: ['items-prod-ready'],
    queryFn: () => Api.items.list({ sampleStatus: 'PRODUCTION_READY' }),
    enabled: open,
  });

  const casting = (metaQ.data?.processes ?? []).find((p) => p.code === 'CASTING');
  const processVendors = casting?.vendors ?? [];

  React.useEffect(() => {
    if (!open) return;
    setBatchDate(today); setNotes(''); setRows([emptyRow()]); setBatchNumber('…');
    Api.casting.nextBatchNumber().then((r) => setBatchNumber(r.batchNumber)).catch(() => setBatchNumber(''));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRow = (idx: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const chosenItemIds = rows.map((r) => r.itemId).filter((x): x is number => !!x);

  const save = useMutation({
    mutationFn: async () => {
      const num = (v?: string) => (v !== undefined && v !== '' ? Number(v) : undefined);
      const items = rows
        .filter((r) => r.itemId && Number(r.quantity) > 0)
        .map((r) => ({
          itemId: r.itemId,
          quantity: Number(r.quantity),
          vendorId: r.vendorId ? Number(r.vendorId) : undefined,
          weight: num(r.weight),
          costPerKg: num(r.costPerKg),
          totalWeight: num(r.totalWeight),
          remarks: r.remarks || undefined,
        }));
      // Pending settles + plans flatten across all rows.
      const allSettles = rows.flatMap((r) => r.pendingSettles ?? []);
      const allPlans = rows.flatMap((r) => r.pendingPlans ?? []);
      if (!items.length && !allSettles.length && !allPlans.length) {
        throw new Error('Add at least one design (cast new pieces, absorb existing stock, or plan an at-vendor return).');
      }
      const created = await Api.casting.createBatch({ batchDate, notes: notes || undefined, items });
      // Settle now — child stages land in the new batch.
      for (const s of allSettles) {
        await Api.casting.settle({
          stageIds: s.stageIds, nextProcessId: s.nextProcessId, color: s.color,
          vendorId: s.vendorId, maxQty: s.maxQty, targetBatchId: created.id,
        });
      }
      // Register at-vendor plans FIRST so receive-now receipts can find them
      // and auto-forward into the new batch.
      for (const p of allPlans) {
        await Api.casting.planForward(p.stageId, {
          nextProcessId: p.nextProcessId, vendorId: p.vendorId, color: p.color,
          targetBatchId: created.id,
        });
      }
      // Group receive-now plans by source batch + vendor, fire one receipt per
      // group. Each receipt triggers the backend auto-forward (because the plan
      // is now registered above), so received pieces land in the new batch.
      const receiveNowPlans = allPlans.filter((p) => p.receiveNow && p.receiveQty > 0);
      const groupKey = (p: PendingPlan) => `${p.sourceBatchId}:${p.sourceVendorId}`;
      const groupedReceipts = new Map<string, PendingPlan[]>();
      for (const p of receiveNowPlans) {
        const key = groupKey(p);
        const arr = groupedReceipts.get(key) ?? [];
        arr.push(p);
        groupedReceipts.set(key, arr);
      }
      const receiveNowTotal = receiveNowPlans.reduce((s, p) => s + p.receiveQty, 0);
      for (const group of groupedReceipts.values()) {
        const sample = group[0];
        await Api.casting.createReceipt({
          batchId: sample.sourceBatchId,
          vendorId: sample.sourceVendorId,
          receiptDate: batchDate,
          notes: `Auto-receipt at new batch ${created.batchNumber} creation`,
          items: group.map((p) => ({
            batchItemId: p.stageId,
            receivedQty: p.receiveQty,
            receivedWeight: Math.round(p.receiveQty * p.perPieceWeight * 1000) / 1000,
          })),
        });
      }
      return {
        ...created,
        absorbed: allSettles.reduce((sum, s) => sum + s.maxQty, 0),
        planned: allPlans.filter((p) => !p.receiveNow).reduce((sum, p) => sum + p.qty, 0),
        receivedNow: receiveNowTotal,
      };
    },
    onSuccess: (res: any) => {
      const absorbed = res.absorbed ?? 0;
      const planned = res.planned ?? 0;
      const receivedNow = res.receivedNow ?? 0;
      const extras: string[] = [];
      if (absorbed > 0) extras.push(`${absorbed} pcs absorbed`);
      if (receivedNow > 0) extras.push(`${receivedNow} pcs received now`);
      if (planned > 0) extras.push(`${planned} pcs scheduled to auto-route on receipt`);
      toast.success(
        extras.length
          ? `Production batch ${res.batchNumber} created — ${extras.join(', ')}.`
          : `Production batch ${res.batchNumber} created (Casting issued).`,
      );
      qc.invalidateQueries({ queryKey: ['casting-batches'] });
      qc.invalidateQueries({ queryKey: ['casting-batch'] });
      qc.invalidateQueries({ queryKey: ['casting-pending'] });
      qc.invalidateQueries({ queryKey: ['casting-receipts'] });
      qc.invalidateQueries({ queryKey: ['produced'] });
      // Receive-now creates auto-receipts → may consume materials → refresh
      // every page that surfaces material-issue state so we don't show stale.
      qc.invalidateQueries({ queryKey: ['material-issues'] });
      qc.invalidateQueries({ queryKey: ['material-issue'] });
      qc.invalidateQueries({ queryKey: ['vendor-holdings'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
      qc.invalidateQueries({ queryKey: ['variants'] });
      onSaved(res.id);
    },
    onError: (e) => toast.error(e instanceof Error && !(e as any).response ? e.message : getApiError(e).message),
  });

  return (
    <Dialog open={open} onClose={onClose} size="xl"
      title="New Production Batch"
      description="Production starts at Casting. Add designs by quantity — vendor, weight & cost auto-fetch. Forward to the next process from the batch later."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Spinner />} Create &amp; Issue Casting
          </Button>
        </>
      }>
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Batch Number"><Input readOnly disabled value={batchNumber} className="bg-muted font-semibold" /></Field>
          <Field label="Batch Date"><Input type="date" value={batchDate} onChange={(e) => setBatchDate(e.target.value)} /></Field>
          <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>

        <div>
          <SectionTitle>Designs to Cast</SectionTitle>
          <div className="space-y-2">
            {rows.map((r, idx) => (
              <CastingRow key={idx} row={r} castingProcessId={casting?.id ?? 0}
                processVendors={processVendors} allVendors={metaQ.data?.allVendors ?? []}
                items={itemsQ.data ?? []}
                chosenItemIds={chosenItemIds.filter((id) => id !== r.itemId)}
                meta={metaQ.data ?? ({ processes: [], allVendors: [], designers: [], services: [], variants: [], sampleStatuses: [] } as unknown as ItemMeta)}
                onChange={(patch) => setRow(idx, patch)}
                onRemove={() => setRows((rs) => rs.filter((_, i) => i !== idx))} />
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setRows((rs) => [...rs, emptyRow()])}>
            <Plus className="size-4" /> Add Design
          </Button>
          {(itemsQ.data ?? []).length === 0 && (
            <p className="mt-2 text-sm text-amber-700">No Production-Ready designs yet. Mark designs as Production Ready first.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
