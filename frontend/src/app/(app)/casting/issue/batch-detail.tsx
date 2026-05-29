'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDown, XCircle, RotateCcw, ArrowRight, Palette, Trash2, Pencil, ChevronRight, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/shared/field';
import { CastingStatusBadge } from '@/components/shared/status-badge';
import { Spinner } from '@/components/ui/spinner';
import { formatDate } from '@/lib/utils';
import type { ItemMeta } from '@/lib/types';

// Colour-coded lifecycle status pill (batch + stage).
const STATUS_CLS: Record<string, string> = {
  Issued: 'bg-slate-100 text-slate-700',
  Pending: 'bg-slate-100 text-slate-700',
  'In Process': 'bg-sky-100 text-sky-700',
  Partial: 'bg-amber-100 text-amber-700',
  Completed: 'bg-emerald-100 text-emerald-700',
  Closed: 'bg-red-100 text-red-700',
};
function ProdStatus({ label }: { label: string }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_CLS[label] ?? 'bg-slate-100 text-slate-700'}`}>{label}</span>;
}

// Split a whole quantity into k whole-number parts (remainder spread to the first parts).
function splitWhole(total: number, k: number): number[] {
  if (k <= 0) return [];
  const base = Math.floor(total / k);
  const rem = total - base * k;
  return Array.from({ length: k }, (_, i) => base + (i < rem ? 1 : 0));
}

// Dialog to forward a stage's received pieces to the next process (= issue slip).
// Colour steps (Plating/Meena/Fitting/Mala/Sticking) allow MULTIPLE colours — the
// quantity is split into whole numbers across them, and each colour becomes its own
// issue (its own vendor + slip). Non-colour steps forward as a single issue.
function ForwardDialog({ stage, open, onClose, onDone }: { stage: any; open: boolean; onClose: () => void; onDone: () => void }) {
  const [processId, setProcessId] = React.useState<number | ''>('');
  const [vendorId, setVendorId] = React.useState<number | ''>('');   // non-colour steps only
  const [vendorRef, setVendorRef] = React.useState('');               // non-colour steps only
  const [quantity, setQuantity] = React.useState('');
  const [weight, setWeight] = React.useState('');      // per-piece weight for the NEXT process
  const [totalWeight, setTotalWeight] = React.useState(''); // manual override for KG steps
  const [rate, setRate] = React.useState('');          // non-colour: rate/kg or cost/pc
  const [colors, setColors] = React.useState<string[]>([]); // colour steps: multi-select
  const [colorQty, setColorQty] = React.useState<Record<string, string>>({}); // editable per-colour qty
  const [colorVendor, setColorVendor] = React.useState<Record<string, number>>({}); // per-colour vendor override
  const [bringsOwnMaterials, setBringsOwnMaterials] = React.useState(false); // sticking: vendor brings own raw materials
  const [bufferPercent, setBufferPercent] = React.useState('0'); // sticking: extra % over BOM
  // sticking: editable qty per material variant (variantId → string for free typing).
  // Empty/unset → BOM × qty × (1 + buffer%) default is used on the server.
  const [materialOverride, setMaterialOverride] = React.useState<Record<number, string>>({});

  const metaQ = useQuery<ItemMeta>({ queryKey: ['item-meta'], queryFn: () => Api.items.meta(), enabled: open });
  // Hide steps already done in this line (the source stage carries the line's process codes).
  const doneCodes: string[] = stage?.lineCodes ?? [];
  const processes = (metaQ.data?.processes ?? []).filter(
    (p) => p.code !== 'DESIGN_CAD' && p.code !== 'CASTING' && !doneCodes.includes(p.code),
  );
  const targetProc = processes.find((p) => p.id === Number(processId));
  const isKg = targetProc?.costUnit === 'KG';
  const targetIsSticking = targetProc?.code === 'STICKING';
  const allVendors = metaQ.data?.allVendors ?? [];

  // Design blueprint — to read the per-colour vendor/ref/rate and the vendor prefill.
  const itemQ = useQuery({ queryKey: ['item', stage?.itemId], queryFn: () => Api.items.get(stage.itemId), enabled: open && !!stage?.itemId });
  const procVendors: any[] = React.useMemo(() => {
    if (!itemQ.data || !processId) return [];
    const proc = (itemQ.data.processes ?? []).find((p: any) => p.processId === Number(processId));
    return proc?.vendors ?? [];
  }, [itemQ.data, processId]);
  // Distinct colour options for the target process (each carries its vendor/ref/rate).
  const procColours: any[] = React.useMemo(() => {
    const m = new Map<string, any>();
    for (const v of procVendors) { const nm = (v.color ?? '').trim(); if (nm && !m.has(nm.toLowerCase())) m.set(nm.toLowerCase(), v); }
    return Array.from(m.values());
  }, [procVendors]);
  const isColourStep = procColours.length > 0;

  React.useEffect(() => {
    if (open && stage) {
      setProcessId(''); setVendorId(''); setVendorRef('');
      setQuantity(String(stage.availableToForward ?? ''));
      setWeight(stage.weight ? String(stage.weight) : ''); // carry latest weight forward
      setRate(''); setColors([]); setBringsOwnMaterials(false); setBufferPercent('0'); setTotalWeight(''); setColorVendor({});
      setMaterialOverride({});
    }
  }, [open, stage]);

  // On process change: colour step → preselect the preferred (first) colour; otherwise
  // prefill the preferred/first vendor for the single-issue path.
  React.useEffect(() => {
    if (!processId) { setVendorId(''); setVendorRef(''); setRate(''); setColors([]); return; }
    if (procColours.length) {
      setColors([procColours[0].color]);
      setVendorId(''); setVendorRef(''); setRate('');
      // For sticking, the toggle defaults to the first colour vendor's master flag.
      if (targetIsSticking) setBringsOwnMaterials(!!procColours[0].bringsOwnMaterials);
    } else {
      const pref = procVendors.find((v: any) => v.isPreferred) ?? procVendors[0];
      setColors([]);
      setVendorId(pref?.vendorId ?? '');
      setVendorRef(pref?.vendorDesignReference ?? '');
      setRate(pref?.costPerPiece != null ? String(pref.costPerPiece) : '');
      if (targetIsSticking) setBringsOwnMaterials(!!pref?.bringsOwnMaterials);
    }
  }, [processId, procColours.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const qty = Number(quantity || 0);
  const wt = Number(weight || 0);
  const toggleColour = (name: string) =>
    setColors((cs) => (cs.includes(name) ? cs.filter((c) => c !== name) : [...cs, name]));

  // Splits we'll actually send to the server — colour step splits per colour qty,
  // single-issue step is one split with the full quantity. Reused for BOM preview
  // and for the proportional materialIssueOverride sent per stage.
  const issueSplits: { color: string | null; quantity: number }[] = isColourStep
    ? colors.map((c) => ({ color: c, quantity: Number(colorQty[c] || 0) })).filter((s) => s.quantity > 0)
    : qty > 0 ? [{ color: null, quantity: qty }] : [];
  const totalIssueQty = issueSplits.reduce((s, x) => s + x.quantity, 0);

  // Fetch BOM × qty preview when forwarding to Sticking (and not "brings own").
  // Re-runs when colours / quantities / buffer change so defaults stay live.
  const bomPreviewQ = useQuery({
    queryKey: ['sticking-bom-preview', stage?.itemId, JSON.stringify(issueSplits), bufferPercent],
    queryFn: () => Api.casting.previewStickingIssue({
      itemId: stage!.itemId,
      splits: issueSplits.map((s) => ({ color: s.color, quantity: s.quantity })),
      bufferPercent: Number(bufferPercent || 0),
    }),
    enabled: open && targetIsSticking && !bringsOwnMaterials && !!stage?.itemId && totalIssueQty > 0,
  });

  // Primary vendor for the sticking issue — used to fetch their existing
  // material holdings so the BOM preview can subtract "vendor already has X".
  // For multi-vendor colour splits, picks the first split's vendor; the UI
  // shows a note when other splits go elsewhere.
  const primaryVendorId: number | null = React.useMemo(() => {
    if (!targetIsSticking || bringsOwnMaterials) return null;
    if (isColourStep) {
      // First selected colour with qty > 0.
      const firstSplit = colors.find((c) => Number(colorQty[c] || 0) > 0);
      if (!firstSplit) return null;
      const overrideId = colorVendor[firstSplit];
      if (overrideId) return overrideId;
      const auto = procColours.find((v) => (v.color ?? '').trim().toLowerCase() === firstSplit.trim().toLowerCase());
      return auto?.vendorId ?? null;
    }
    return vendorId ? Number(vendorId) : null;
  }, [targetIsSticking, bringsOwnMaterials, isColourStep, colors, colorQty, colorVendor, procColours, vendorId]);
  const vendorHoldingsQ = useQuery({
    queryKey: ['vendor-holdings', primaryVendorId],
    queryFn: () => Api.materialIssues.vendorHoldings(primaryVendorId!),
    enabled: open && primaryVendorId != null,
  });
  const heldByVariant = React.useMemo(() => {
    const m = new Map<number, number>();
    for (const h of (vendorHoldingsQ.data ?? []) as any[]) {
      m.set(h.variantId, (m.get(h.variantId) ?? 0) + Number(h.qty));
    }
    return m;
  }, [vendorHoldingsQ.data]);

  // Auto-pre-fill the override map with "min new" qty when the vendor already
  // holds materials — so the submit uses the reduced qty rather than the
  // server's default of BOM × buffer (which would over-issue).
  React.useEffect(() => {
    if (!targetIsSticking || bringsOwnMaterials) return;
    if (!bomPreviewQ.data?.lines?.length) return;
    if (heldByVariant.size === 0) return;
    const buffer = Number(bufferPercent || 0);
    setMaterialOverride((m) => {
      const next = { ...m };
      let changed = false;
      for (const ln of bomPreviewQ.data!.lines) {
        const held = heldByVariant.get(ln.variantId) ?? 0;
        if (held <= 0) continue;
        // Only set if the user hasn't already typed an override.
        if (next[ln.variantId] !== undefined) continue;
        const need = Math.max(0, ln.required - held);
        const minNew = Math.max(0, Math.ceil(need * (1 + buffer / 100)));
        next[ln.variantId] = String(minNew);
        changed = true;
      }
      return changed ? next : m;
    });
  }, [bomPreviewQ.data, heldByVariant, bufferPercent, targetIsSticking, bringsOwnMaterials]);

  // When the colour selection or total qty changes, pre-fill an equal whole-number
  // split; the per-colour quantities remain individually editable afterwards.
  React.useEffect(() => {
    if (!isColourStep || !colors.length) { setColorQty({}); return; }
    const parts = splitWhole(qty, colors.length);
    const next: Record<string, string> = {};
    colors.forEach((c, i) => { next[c] = String(parts[i]); });
    setColorQty(next);
  }, [colors.join('|'), quantity, isColourStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-colour parts (from the editable quantities). Vendor falls back to the
  // colour's master vendor unless the user picked an override in the dropdown.
  const splits = colors.map((c) => {
    const auto = procColours.find((x) => (x.color ?? '').trim().toLowerCase() === c.trim().toLowerCase());
    const overrideId = colorVendor[c];
    const overrideVendor = overrideId
      ? allVendors.find((av: any) => av.id === overrideId)
      : null;
    const vendor = overrideVendor
      ? {
          vendorId: overrideVendor.id,
          vendorCode: overrideVendor.vendorCode,
          vendorName: overrideVendor.vendorName,
          // Keep auto-colour's ref/cost since the master row is keyed by colour+vendor.
          vendorDesignReference: auto?.vendorDesignReference,
          costPerPiece: auto?.costPerPiece,
          bringsOwnMaterials: auto?.bringsOwnMaterials,
        }
      : auto;
    const q = Number(colorQty[c] || 0);
    const r = vendor?.costPerPiece != null ? Number(vendor.costPerPiece) : 0;
    const cost = isKg ? (wt * q / 1000) * r : r * q;
    return { color: c, qty: q, vendor, rate: r, cost };
  });
  const splitSum = splits.reduce((a, s) => a + s.qty, 0);

  const totalCost = isColourStep
    ? splits.reduce((s, x) => s + x.cost, 0)
    : (isKg ? (wt * qty / 1000) * Number(rate || 0) : Number(rate || 0) * qty);

  // Build an override list for ONE forward stage from the user-edited totals,
  // distributing each variant's qty proportionally to that stage's share of the
  // total forwarded qty. Last stage absorbs any rounding remainder so the sum
  // equals the user-typed totals exactly.
  function buildOverrideForStage(stageQty: number, stageIndex: number, totalStages: number) {
    if (!targetIsSticking || bringsOwnMaterials) return undefined;
    const lines = bomPreviewQ.data?.lines ?? [];
    if (!lines.length || totalIssueQty <= 0) return undefined;
    const result: { variantId: number; issuedQty: number }[] = [];
    for (const ln of lines) {
      const raw = materialOverride[ln.variantId];
      // Only send the variants the user actually touched — server falls back to
      // BOM × qty × (1 + buffer%) for everything else.
      if (raw === undefined || raw === '') continue;
      const total = Math.max(0, Math.trunc(Number(raw) || 0));
      const share = stageIndex === totalStages - 1
        ? total - Math.floor(total * ((totalIssueQty - stageQty) / totalIssueQty))
        : Math.floor(total * (stageQty / totalIssueQty));
      result.push({ variantId: ln.variantId, issuedQty: Math.max(0, share) });
    }
    return result.length ? result : undefined;
  }

  const forward = useMutation({
    mutationFn: async () => {
      if (!processId) throw new Error('Choose the next process.');
      if (qty <= 0) throw new Error('Enter a quantity.');
      if (qty > (stage.availableToForward ?? 0)) throw new Error(`Only ${stage.availableToForward} available to forward.`);
      if (isColourStep) {
        if (!colors.length) throw new Error('Select at least one colour.');
        const active = splits.filter((s) => s.qty > 0);
        if (!active.length) throw new Error('Enter a quantity for at least one colour.');
        if (splitSum > (stage.availableToForward ?? 0)) throw new Error(`Colour quantities total ${splitSum}, but only ${stage.availableToForward} available.`);
        // One issue (stage + slip) per colour with qty > 0; quantities are user-adjustable.
        for (let i = 0; i < active.length; i++) {
          const part = active[i];
          await Api.casting.forwardStage(stage.id, {
            processId: Number(processId), quantity: part.qty,
            vendorId: part.vendor?.vendorId,
            vendorDesignReference: part.vendor?.vendorDesignReference || undefined,
            weight: weight !== '' ? Number(weight) : undefined,
            costPerKg: part.vendor?.costPerPiece != null ? Number(part.vendor.costPerPiece) : undefined,
            color: part.color,
            bringsOwnMaterials: targetIsSticking ? bringsOwnMaterials : undefined,
            materialBufferPercent: targetIsSticking && !bringsOwnMaterials ? Number(bufferPercent || 0) : undefined,
            materialIssueOverride: buildOverrideForStage(part.qty, i, active.length),
          });
        }
        return { count: active.length };
      }
      if (!vendorId) throw new Error('Choose a vendor.');
      await Api.casting.forwardStage(stage.id, {
        processId: Number(processId), quantity: qty,
        vendorId: Number(vendorId),
        vendorDesignReference: vendorRef || undefined,
        weight: weight !== '' ? Number(weight) : undefined,
        totalWeight: totalWeight !== '' ? Number(totalWeight) : undefined,
        costPerKg: rate !== '' ? Number(rate) : undefined,
        bringsOwnMaterials: targetIsSticking ? bringsOwnMaterials : undefined,
        materialBufferPercent: targetIsSticking && !bringsOwnMaterials ? Number(bufferPercent || 0) : undefined,
        materialIssueOverride: buildOverrideForStage(qty, 0, 1),
      });
      return { count: 1 };
    },
    onSuccess: (r: any) => { toast.success(r.count > 1 ? `Issued in ${r.count} colours — ${r.count} slips created.` : 'Issued to next process (new slip created).'); onDone(); onClose(); },
    onError: (e: any) => {
      // Raw-material shortage on sticking forward — surface a structured popup
      // with shortage details + a link to Inventory so the user can order more
      // before retrying. The backend throws BadRequestException with a body
      // containing `shortages`.
      const body = e?.response?.data;
      const shortages = body?.shortages ?? body?.message?.shortages;
      if (Array.isArray(shortages) && shortages.length) {
        setStockShortage(shortages);
        return;
      }
      toast.error(e instanceof Error && !(e as any).response ? e.message : getApiError(e).message);
    },
  });
  const [stockShortage, setStockShortage] = React.useState<any[] | null>(null);

  if (!stage) return null;
  return (
    <Dialog open={open} onClose={onClose} size="md"
      title={`Issue for next process — ${stage.vendorDesignReference || stage.processName}`}
      description={`${stage.availableToForward} received piece(s) available to forward from ${stage.processName}.`}
      footer={<><Button variant="outline" onClick={onClose} disabled={forward.isPending}>Cancel</Button>
        <Button onClick={() => forward.mutate()} disabled={forward.isPending}>{forward.isPending && <Spinner />} Issue &amp; Generate Slip</Button></>}>
      <div className="space-y-3">
        <Field label="Next process"><Select value={processId} onChange={(e) => setProcessId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">— Select —</option>
          {processes.map((p) => <option key={p.id} value={p.id}>{p.name}{p.costUnit === 'KG' ? ' (per kg)' : ''}</option>)}
        </Select></Field>

        <div className={`grid gap-3 ${isKg ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <Field label="Quantity" hint={`Max ${stage.availableToForward}`}><Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
          <Field label="Wt / pc (g)" hint="carries to this step"><Input type="number" step="0.001" value={weight}
            onChange={(e) => { setWeight(e.target.value); setTotalWeight(''); }} /></Field>
          {isKg && (
            <Field label="Total Wt (g) · editable" hint="override if actual weighs differently">
              <Input type="number" step="0.001"
                value={totalWeight !== '' ? totalWeight : String((Number(weight || 0) * Number(quantity || 0)) || '')}
                onChange={(e) => setTotalWeight(e.target.value)} />
            </Field>
          )}
        </div>

        {isColourStep ? (
          <Field label="Colours for this step" hint="Tick colours — qty auto-splits in whole numbers but each is editable; each colour → its own vendor & slip">
            <div className="space-y-1.5 rounded-lg border border-border p-2">
              {procColours.map((v) => {
                const checked = colors.includes(v.color);
                const effVendorId = colorVendor[v.color] ?? v.vendorId;
                return (
                  <div key={v.id} className="rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
                    <div className="flex items-center justify-between gap-2">
                      <label className="flex flex-1 cursor-pointer items-center gap-2">
                        <input type="checkbox" className="size-4 accent-primary" checked={checked} onChange={() => toggleColour(v.color)} />
                        <span className="font-medium">{v.color}</span>
                        {v.colorCode && <span className="text-xs text-muted-foreground">({v.colorCode})</span>}
                        <span className="truncate text-xs text-muted-foreground">· default {v.vendorCode} · {isKg ? `₹${v.costPerPiece}/kg` : `₹${v.costPerPiece}/pc`}</span>
                      </label>
                      {checked && (
                        <div className="flex items-center gap-1">
                          <Input type="number" min={0} className="h-7 w-20 text-right"
                            value={colorQty[v.color] ?? ''}
                            onChange={(e) => setColorQty((m) => ({ ...m, [v.color]: e.target.value }))} />
                          <span className="text-xs text-muted-foreground">pcs</span>
                        </div>
                      )}
                    </div>
                    {checked && (
                      <div className="ml-6 mt-1.5 flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">Vendor:</span>
                        <div className="w-64">
                          <SearchableSelect
                            value={effVendorId}
                            onChange={(val) => setColorVendor((m) => ({ ...m, [v.color]: Number(val) }))}
                            // Only vendors who handle THIS next process (e.g. "Mala"
                            // shows only Mala vendors). Falls back to the design's
                            // blueprint vendors if the meta list is empty.
                            options={(targetProc?.vendors ?? procVendors).map((vv: any) => ({
                              value: vv.id ?? vv.vendorId,
                              label: `${vv.vendorCode} · ${vv.vendorName}`,
                              keywords: vv.vendorName,
                            }))}
                          />
                        </div>
                        {effVendorId !== v.vendorId && (
                          <button type="button"
                            className="text-xs text-primary hover:underline"
                            onClick={() => setColorVendor((m) => { const n = { ...m }; delete n[v.color]; return n; })}>
                            Reset to default
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Field>
        ) : (
          <>
            <Field label="Vendor (vendors of this process · preferred ★ auto-selected)">
              <SearchableSelect
                value={vendorId}
                placeholder={processId ? '— Select vendor —' : 'Pick a process first'}
                disabled={!processId}
                onChange={(val) => setVendorId(val ? Number(val) : '')}
                // Only vendors who handle the SELECTED next process — not all vendors.
                // Preferred (★) is the design's blueprint pick for this process.
                options={(targetProc?.vendors ?? []).map((v: any) => {
                  const pref = procVendors.some((pv: any) => pv.vendorId === v.id && pv.isPreferred);
                  return { value: v.id, label: `${v.vendorCode} · ${v.vendorName}${pref ? ' ★' : ''}`, keywords: v.vendorName };
                })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Vendor Design Ref"><Input value={vendorRef} onChange={(e) => setVendorRef(e.target.value)} placeholder="vendor's own code" /></Field>
              <Field label={isKg ? 'Rate / KG' : 'Cost / pc'}><Input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
            </div>
          </>
        )}

        {isColourStep && colors.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Total across colours: <strong className="text-foreground">{splitSum}</strong> pcs
            {splitSum > (stage.availableToForward ?? 0) ? ` ⚠ exceeds available (${stage.availableToForward})` : ` of ${stage.availableToForward} available`}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Est. cost: <strong className="text-foreground">{totalCost ? `₹${totalCost.toFixed(2)}` : '—'}</strong>
          {isColourStep ? ' (sum across colours)' : isKg ? ' (total wt ÷ 1000 × rate/kg)' : ' (cost/pc × qty)'} · weight carries forward to the slip.
        </p>

        {targetIsSticking && (
          <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm">
            <label className="flex cursor-pointer items-center gap-2 font-medium text-sky-900">
              <input type="checkbox" className="size-4 accent-primary" checked={bringsOwnMaterials}
                onChange={(e) => setBringsOwnMaterials(e.target.checked)} />
              Karigar brings their own raw materials (no material issue voucher)
            </label>
            {!bringsOwnMaterials && (
              <>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-sky-900">
                  <span>A material-issue voucher will be auto-created with BOM × qty.</span>
                  <span className="text-sky-700">Buffer:</span>
                  <Input type="number" min="0" step="1" className="h-7 w-16 text-right"
                    value={bufferPercent}
                    onChange={(e) => setBufferPercent(e.target.value.replace(/[^0-9]/g, ''))} />
                  <span className="text-sky-700">% extra → defaults below recalculate.</span>
                </div>

                {/* Editable Materials-to-Issue table — user can override any default. */}
                {totalIssueQty > 0 && (
                  <div className="mt-3 overflow-hidden rounded-md border border-sky-200 bg-white">
                    <div className="flex items-center justify-between border-b border-sky-200 bg-sky-100/50 px-3 py-1.5 text-xs font-semibold text-sky-900">
                      <span>Materials to issue · edit any qty (whole pieces)</span>
                      <span className="text-[10px] font-normal text-sky-700">{bomPreviewQ.isFetching ? 'recomputing…' : `for ${totalIssueQty} pcs across ${issueSplits.length} colour-lot(s)`}</span>
                    </div>
                    {bomPreviewQ.isLoading ? (
                      <div className="px-3 py-2 text-xs text-sky-700">Loading BOM…</div>
                    ) : (bomPreviewQ.data?.lines?.length ?? 0) === 0 ? (
                      <div className="px-3 py-2 text-xs text-sky-700">No BOM configured for this design + colour.</div>
                    ) : (
                      <table className="w-full text-xs">
                        <thead className="bg-sky-50 text-left text-sky-700">
                          <tr>
                            <th className="px-3 py-1.5 font-medium">Material</th>
                            <th className="px-3 py-1.5 text-right font-medium">BOM req.</th>
                            <th className="px-3 py-1.5 text-right font-medium" title="Vendor already holds this much from previous issues">Vendor has</th>
                            <th className="px-3 py-1.5 text-right font-medium" title="Minimum new qty we need to issue (BOM req. − vendor has, × buffer)">Min new</th>
                            <th className="px-3 py-1.5 text-right font-medium">In stock</th>
                            <th className="px-3 py-1.5 text-right font-medium">Issue qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bomPreviewQ.data!.lines.map((ln) => {
                            const value = materialOverride[ln.variantId] ?? '';
                            const held = heldByVariant.get(ln.variantId) ?? 0;
                            // Min new = BOM requirement reduced by what vendor already holds,
                            // then expanded by buffer. Default issue qty becomes this when no
                            // override is set, so we never over-issue when vendor still has stock.
                            const buffer = Number(bufferPercent || 0);
                            const need = Math.max(0, ln.required - held);
                            const minNew = Math.max(0, Math.ceil(need * (1 + buffer / 100)));
                            const computedDefault = held > 0 ? minNew : ln.defaultIssue;
                            const effective = value !== '' ? Math.max(0, Math.trunc(Number(value) || 0)) : computedDefault;
                            const short = effective > ln.stockQty;
                            return (
                              <tr key={ln.variantId} className="border-t border-sky-100">
                                <td className="px-3 py-1.5">
                                  <div className="font-medium text-foreground">{ln.variantName}</div>
                                  <div className="text-[10px] text-muted-foreground">{ln.variantCode}{ln.unit ? ` · ${ln.unit}` : ''}</div>
                                </td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{ln.required}</td>
                                <td className={`px-3 py-1.5 text-right tabular-nums ${held > 0 ? 'text-emerald-700 font-medium' : 'text-muted-foreground'}`}>{held}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums font-medium text-sky-900">{minNew}</td>
                                <td className={`px-3 py-1.5 text-right tabular-nums ${short ? 'text-red-600 font-medium' : ''}`}>{ln.stockQty}</td>
                                <td className="px-3 py-1.5 text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    <Input
                                      type="number" min="0" step="1"
                                      className="h-7 w-20 text-right"
                                      placeholder={String(computedDefault)}
                                      value={value}
                                      onChange={(e) =>
                                        setMaterialOverride((m) => ({
                                          ...m,
                                          [ln.variantId]: e.target.value.replace(/[^0-9]/g, ''),
                                        }))
                                      }
                                    />
                                    {value !== '' && (
                                      <button
                                        type="button"
                                        title="Reset to default"
                                        className="text-[10px] text-primary hover:underline"
                                        onClick={() =>
                                          setMaterialOverride((m) => {
                                            const n = { ...m };
                                            delete n[ln.variantId];
                                            return n;
                                          })
                                        }
                                      >
                                        ↺
                                      </button>
                                    )}
                                  </div>
                                  {short && (
                                    <div className="text-[10px] text-red-600">short by {effective - ln.stockQty}</div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                    <div className="border-t border-sky-200 bg-sky-50 px-3 py-1.5 text-[10px] text-sky-700">
                      Leave a row blank to use the BOM × qty × buffer default. Edited rows override the auto-calc.
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {/* Raw-material shortage popup — shown when the backend refuses the issue
          because stock is insufficient. Lists every shortage with a deep-link
          to Raw Materials Inventory so the user can order more before retrying. */}
      {stockShortage && stockShortage.length > 0 && (
        <Dialog open onClose={() => setStockShortage(null)} size="md"
          title="Raw materials not available"
          description="Cannot issue to sticking — some materials don't have enough stock to cover the BOM."
          footer={
            <>
              <Button variant="outline" onClick={() => setStockShortage(null)}>Close</Button>
              <a href="/inventory" target="_blank" rel="noreferrer">
                <Button>Open Raw Materials Inventory</Button>
              </a>
            </>
          }>
          <div className="space-y-2">
            <p className="text-sm text-amber-900">
              Order or restock these materials before issuing this sticking batch. The forward is paused — your typed-in values are still here when you come back.
            </p>
            <div className="overflow-hidden rounded-md border border-red-200">
              <table className="w-full text-sm">
                <thead className="bg-red-50 text-left text-xs text-red-900">
                  <tr>
                    <th className="px-2 py-1.5">Material</th>
                    <th className="px-2 py-1.5 text-right">Need</th>
                    <th className="px-2 py-1.5 text-right">In stock</th>
                    <th className="px-2 py-1.5 text-right">Short by</th>
                  </tr>
                </thead>
                <tbody>
                  {stockShortage.map((s: any) => (
                    <tr key={s.variantId} className="border-t border-red-100">
                      <td className="px-2 py-1.5">
                        <div className="font-medium text-foreground">{s.variantName || s.variantCode}</div>
                        <div className="text-[10px] text-muted-foreground">{s.variantCode}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{s.need}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{s.have}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-red-700">{s.short}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Dialog>
      )}
    </Dialog>
  );
}

// Dialog to EDIT a stage (vendor / qty / weight / rate / colour / remarks).
const KG_PROCS = ['CASTING', 'PLATING', 'ANTIQUE'];
function EditStageDialog({ stage, open, onClose, onDone }: { stage: any; open: boolean; onClose: () => void; onDone: () => void }) {
  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [vendorRef, setVendorRef] = React.useState('');
  const [quantity, setQuantity] = React.useState('');
  const [weight, setWeight] = React.useState('');
  const [totalWeight, setTotalWeight] = React.useState('');
  const [rate, setRate] = React.useState('');
  const [color, setColor] = React.useState('');
  const [remarks, setRemarks] = React.useState('');

  const metaQ = useQuery<ItemMeta>({ queryKey: ['item-meta'], queryFn: () => Api.items.meta(), enabled: open });
  const allVendors = metaQ.data?.allVendors ?? [];
  const isKg = stage ? KG_PROCS.includes(stage.processCode) : false;

  React.useEffect(() => {
    if (open && stage) {
      setVendorId(stage.vendorId); setVendorRef(stage.vendorDesignReference ?? '');
      setQuantity(String(stage.quantity)); setWeight(String(stage.weight));
      setTotalWeight(String(stage.totalWeight)); setRate(stage.costPerKg != null ? String(stage.costPerKg) : '');
      setColor(stage.color ?? ''); setRemarks(stage.remarks ?? '');
    }
  }, [open, stage]);

  const save = useMutation({
    mutationFn: () => Api.casting.updateStage(stage.id, {
      vendorId: vendorId ? Number(vendorId) : undefined,
      vendorDesignReference: vendorRef || undefined,
      quantity: quantity !== '' ? Number(quantity) : undefined,
      weight: weight !== '' ? Number(weight) : undefined,
      totalWeight: totalWeight !== '' ? Number(totalWeight) : undefined,
      costPerKg: rate !== '' ? Number(rate) : undefined,
      color: color || undefined,
      remarks: remarks || undefined,
    }),
    onSuccess: () => { toast.success('Stage updated — slip reflects new details.'); onDone(); onClose(); },
    onError: (e) => toast.error(getApiError(e).message),
  });

  if (!stage) return null;
  return (
    <Dialog open={open} onClose={onClose} size="md"
      title={`Edit — ${stage.processName} (${stage.vendorDesignReference || stage.itemNumber})`}
      footer={<><Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending && <Spinner />} Save</Button></>}>
      <div className="space-y-3">
        <Field label="Vendor">
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">— Select —</option>
            {allVendors.map((v: any) => <option key={v.id} value={v.id}>{v.vendorCode} · {v.vendorName}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vendor Design Ref"><Input value={vendorRef} onChange={(e) => setVendorRef(e.target.value)} /></Field>
          <Field label="Quantity" hint={stage.parentItemId != null ? 'Set by the Send amount' : undefined}>
            <Input type="number" value={quantity} disabled={stage.parentItemId != null}
              className={stage.parentItemId != null ? 'bg-muted' : ''}
              onChange={(e) => { setQuantity(e.target.value); const w = Number(weight || 0); setTotalWeight(w ? String(Math.round(w * Number(e.target.value || 0) * 1000) / 1000) : ''); }} /></Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Wt / pc (g)"><Input type="number" step="0.001" value={weight} onChange={(e) => { setWeight(e.target.value); const q = Number(quantity || 0); setTotalWeight(e.target.value ? String(Math.round(Number(e.target.value) * q * 1000) / 1000) : ''); }} /></Field>
          <Field label="Total Wt (g)"><Input type="number" step="0.001" value={totalWeight} onChange={(e) => setTotalWeight(e.target.value)} /></Field>
          <Field label={isKg ? 'Rate / KG' : 'Cost / pc'}><Input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Colour"><Input value={color} onChange={(e) => setColor(e.target.value)} /></Field>
          <Field label="Remarks"><Input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-muted-foreground">Receipts already recorded are kept. The slip is generated live, so it shows the updated details.</p>
      </div>
    </Dialog>
  );
}

export function BatchDetail({ batchId, open, onClose }: { batchId: number | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [forwardStage, setForwardStage] = React.useState<any>(null);
  const [editStage, setEditStage] = React.useState<any>(null);
  const [openGroups, setOpenGroups] = React.useState<Record<string, boolean>>({});
  const toggleGroup = (k: string) => setOpenGroups((g) => ({ ...g, [k]: !g[k] }));
  // Each design line is collapsible — a batch can hold many designs.
  const [openLines, setOpenLines] = React.useState<Record<string, boolean>>({});
  const toggleLine = (k: string) => setOpenLines((g) => ({ ...g, [k]: !g[k] }));

  const { data: batch, isLoading } = useQuery({
    queryKey: ['casting-batch', batchId],
    queryFn: () => Api.casting.batch(batchId!),
    enabled: open && !!batchId,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['casting-batch', batchId] });
    qc.invalidateQueries({ queryKey: ['casting-batches'] });
    qc.invalidateQueries({ queryKey: ['stock'] });
  };

  const closeItem = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => Api.casting.closeItem(id, reason),
    onSuccess: () => { toast.success('Order closed short. Balance moved to vendor ledger.'); refresh(); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const reopenItem = useMutation({
    mutationFn: (id: number) => Api.casting.reopenItem(id),
    onSuccess: () => { toast.success('Order re-opened.'); refresh(); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const undoReceipt = useMutation({
    mutationFn: (payload: any) => Api.casting.createReceipt(payload),
    onSuccess: () => { toast.success('Receipt restored.'); refresh(); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const closeBatchM = useMutation({
    mutationFn: (reason?: string) => Api.casting.closeBatch(batchId!, reason),
    onSuccess: (r: any) => { toast.success(`Batch closed — ${r.closedStages} stage(s) short-closed.`); refresh(); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const reopenBatchM = useMutation({
    mutationFn: () => Api.casting.reopenBatch(batchId!),
    onSuccess: () => { toast.success('Batch reopened — back to Active.'); refresh(); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const delReceipt = useMutation({
    mutationFn: (id: number) => Api.casting.deleteReceipt(id),
    onSuccess: (res: any) => {
      refresh();
      toast.success('Receipt deleted — balances restored.', {
        action: res?.undo ? { label: 'Undo', onClick: () => undoReceipt.mutate(res.undo) } : undefined,
        duration: 8000,
      });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const onClickClose = (it: any) => {
    const reason = window.prompt(`Close this stage short?\nPending ${it.pendingQty} pcs will be recorded as an outstanding balance against ${it.vendorName}.\n\nReason (optional):`, 'Vendor will not supply / not needed');
    if (reason === null) return;
    closeItem.mutate({ id: it.id, reason });
  };

  // One stage as a TABLE ROW. `sub` = a child row inside a merged process group.
  // `lineCodes` = process codes already in this design line (to hide done steps when forwarding).
  const stageRow = (st: any, sub = false, lineCodes: string[] = []) => (
    <tr key={st.id} className="border-t border-border align-middle">
      <td className="px-3 py-2">
        {sub
          ? <span className="pl-4 text-xs text-muted-foreground">↳ issue</span>
          : <Badge variant="default" className="whitespace-nowrap">{st.processName}</Badge>}
      </td>
      <td className="px-3 py-2"><ProdStatus label={st.status} /></td>
      <td className="truncate px-3 py-2 text-muted-foreground" title={`${st.vendorCode} · ${st.vendorName}`}>{st.vendorCode} · {st.vendorName}</td>
      <td className="truncate px-3 py-2 text-muted-foreground">{st.vendorDesignReference || '—'}</td>
      <td className="truncate px-3 py-2">{st.color ? <Badge variant="outline">{st.color}</Badge> : '—'}</td>
      <td className="px-3 py-2 font-semibold">{st.quantity}</td>
      <td className="px-3 py-2 text-emerald-600">{st.receivedQty}</td>
      <td className="px-3 py-2">
        {st.closed ? <span className="text-slate-500">short {st.shortQty ?? 0}</span>
          : st.pendingQty > 0 ? <span className="text-amber-600">{st.pendingQty} pending</span>
          : st.forwardedQty > 0 ? <span className="text-sky-600">{st.forwardedQty} fwd</span>
          : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-1">
          <Button variant="outline" size="icon" className="size-8" title="Edit this step" onClick={() => setEditStage(st)}>
            <Pencil className="size-4" />
          </Button>
          {st.availableToForward > 0 && (
            <Button variant="outline" size="sm" onClick={() => setForwardStage({ ...st, lineCodes })}>
              Send {st.availableToForward} <ArrowRight className="size-4" />
            </Button>
          )}
          {!st.closed && st.pendingQty > 0 && (
            <Button variant="outline" size="sm" className="text-amber-700 hover:bg-amber-50"
              onClick={() => onClickClose(st)} disabled={closeItem.isPending}>
              <XCircle className="size-4" /> Close
            </Button>
          )}
          {st.closed && (
            <button className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              onClick={() => reopenItem.mutate(st.id)} disabled={reopenItem.isPending}>
              <RotateCcw className="size-3" /> Reopen
            </button>
          )}
        </div>
      </td>
    </tr>
  );

  return (
    <Dialog open={open} onClose={onClose} size="full"
      title={batch ? `Production Batch ${batch.batchNumber}` : 'Production Batch'}
      description={batch ? formatDate(batch.batchDate) : undefined}>
      {isLoading || !batch ? (
        <div className="flex justify-center py-10"><Spinner className="size-6 text-primary" /></div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="order-1 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <ProdStatus label={batch.displayStatus ?? batch.status} />
              <span className="text-sm text-muted-foreground">{batch.lines?.length ?? 0} design line(s) · {batch.vendors.length} vendor(s)</span>
            </div>
            {batch.closed ? (
              <Button variant="outline" size="sm" className="text-primary hover:bg-primary/10"
                disabled={reopenBatchM.isPending}
                onClick={() => {
                  if (!window.confirm('Reopen this short-closed batch? It will return to the Active folder. Per-stage closes stay as they are (reopen them individually if needed).')) return;
                  reopenBatchM.mutate();
                }}>
                <RotateCcw className="size-4" /> Reopen Batch
              </Button>
            ) : batch.displayStatus !== 'Completed' && (
              <Button variant="outline" size="sm" className="text-amber-700 hover:bg-amber-50"
                disabled={closeBatchM.isPending}
                onClick={() => {
                  const reason = window.prompt('Mark this batch Short-Closed?\nEvery still-open stage will be short-closed; the batch moves to the Short-Closed folder.\n\nReason (optional):', '');
                  if (reason === null) return;
                  closeBatchM.mutate(reason || undefined);
                }}>
                <XCircle className="size-4" /> Close Batch Short
              </Button>
            )}
          </div>

          {/* Live verification — a single compact strip so it fits without scrolling */}
          {batch.summary && (
            <div className="order-2 flex flex-wrap gap-x-4 gap-y-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
              {[
                ['Issued', `${batch.summary.issuedQty} pcs · ${batch.summary.issuedWeight} g`],
                ['Received', `${batch.summary.receivedQty} pcs · ${batch.summary.receivedWeight} g`],
                ['Pending', `${batch.summary.pendingQty} pcs · ${batch.summary.balanceWeight} g`],
                ['Excess / Short', `${batch.summary.excessQty} / ${batch.summary.shortQty}`],
              ].map(([label, val]) => (
                <div key={label as string} className="flex items-baseline gap-1.5">
                  <span className="uppercase tracking-wide text-muted-foreground">{label}:</span>
                  <span className="font-semibold text-foreground">{val as any}</span>
                </div>
              ))}
            </div>
          )}

          {/* Slip folders — Process › Vendor › Slips (issue + receipts) — collapsed by default */}
          <details className="order-4 rounded-lg border border-border">
            <summary className="cursor-pointer select-none bg-muted/40 px-3 py-2 text-sm font-semibold">
              📑 Slips — Process › Vendor
            </summary>
            <div className="p-3">
              {(() => {
                // Build folder tree from stages (issue slips) + receipts.
                const folders = new Map<string, { processName: string; vendors: Map<string, any> }>();
                for (const it of batch.items ?? []) {
                  if (!folders.has(it.processName)) folders.set(it.processName, { processName: it.processName, vendors: new Map() });
                  const f = folders.get(it.processName)!;
                  if (!f.vendors.has(it.vendorName)) f.vendors.set(it.vendorName, { vendorName: it.vendorName, vendorCode: it.vendorCode, vendorId: it.vendorId, processId: it.processId, stages: [], slips: new Map<number, any>(), receipts: [] });
                  const vf = f.vendors.get(it.vendorName)!;
                  vf.stages.push(it);
                  // One issue slip per 15-min group (issueSlipId); merge stages of the same slip.
                  const sid = it.issueSlipId ?? it.id;
                  const slip = vf.slips.get(sid) ?? { issueSlipId: sid, qty: 0, colors: [] as string[] };
                  slip.qty += it.quantity;
                  if (it.color && !slip.colors.includes(it.color)) slip.colors.push(it.color);
                  vf.slips.set(sid, slip);
                }
                for (const r of batch.receipts ?? []) {
                  const f = folders.get(r.processName);
                  const v = f?.vendors.get(r.vendorName);
                  if (v) v.receipts.push(r);
                }
                return Array.from(folders.values()).map((f) => (
                  <details key={f.processName} className="rounded-lg border border-border">
                    <summary className="cursor-pointer select-none bg-muted/50 px-3 py-2 text-sm font-semibold">
                      📁 {f.processName}
                    </summary>
                    <div className="space-y-1 p-2">
                      {Array.from(f.vendors.values()).map((v: any) => (
                        <details key={v.vendorName} className="rounded-md border border-border">
                          <summary className="cursor-pointer select-none px-3 py-1.5 text-sm font-medium">
                            📂 {v.vendorCode} · {v.vendorName}
                          </summary>
                          <div className="space-y-1 px-3 pb-2">
                            {/* Issue slips — one per 15-min issue window (issueSlipId) */}
                            {Array.from(v.slips.values()).map((sl: any) => (
                              <div key={sl.issueSlipId} className="flex items-center justify-between gap-2 rounded border border-border bg-card px-2.5 py-1.5 text-sm">
                                <span>🧾 Issue Slip · {sl.colors.length ? `${sl.colors.join(', ')} · ` : ''}{sl.qty} pcs</span>
                                <a href={Api.casting.stagePdfUrl(sl.issueSlipId)} target="_blank" rel="noreferrer">
                                  <Button variant="outline" size="sm"><FileDown className="size-4" /> Open</Button>
                                </a>
                              </div>
                            ))}
                            {/* Receipt slips */}
                            {v.receipts.map((r: any) => (
                              <div key={r.id} className="flex items-center justify-between gap-2 rounded border border-border bg-card px-2.5 py-1.5 text-sm">
                                <span>📥 {r.receiptNumber} · {formatDate(r.receiptDate)} · {r.qty} pcs</span>
                                <div className="flex items-center gap-1">
                                  <a href={Api.casting.receiptPdfUrl(r.id)} target="_blank" rel="noreferrer">
                                    <Button variant="outline" size="sm"><FileDown className="size-4" /> Open</Button>
                                  </a>
                                  <Button variant="outline" size="sm" className="text-destructive hover:bg-destructive/10"
                                    onClick={() => delReceipt.mutate(r.id)} disabled={delReceipt.isPending} title="Delete receipt">
                                    <Trash2 className="size-4" />
                                  </Button>
                                </div>
                              </div>
                            ))}
                            {v.receipts.length === 0 && <div className="px-1 text-xs text-muted-foreground">No receipts yet.</div>}
                          </div>
                        </details>
                      ))}
                    </div>
                  </details>
                ));
              })()}
            </div>
            <p className="px-3 pb-3 text-xs text-muted-foreground">Deleting a receipt restores qty &amp; weight balances (blocked if pieces were already forwarded).</p>
          </details>

          {/* Traveler — each design line and its journey through the processes */}
          <div className="order-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Production Traveler</div>
              {(batch.lines?.length ?? 0) > 1 && (
                <div className="flex gap-1 text-xs">
                  <button className="text-primary hover:underline"
                    onClick={() => setOpenLines(Object.fromEntries((batch.lines ?? []).map((l: any) => [l.lineKey, true])))}>Expand all</button>
                  <span className="text-muted-foreground">·</span>
                  <button className="text-primary hover:underline"
                    onClick={() => setOpenLines(Object.fromEntries((batch.lines ?? []).map((l: any) => [l.lineKey, false])))}>Collapse all</button>
                </div>
              )}
            </div>
            {(batch.lines ?? []).map((line: any) => {
              const isLineOpen = openLines[line.lineKey] ?? ((batch.lines?.length ?? 0) === 1);
              const lineStatus = line.completed
                ? 'Completed'
                : line.stages.some((s: any) => s.receivedQty > 0) ? 'In Process' : 'Issued';
              const furthest = line.stages[line.stages.length - 1];
              const stepCount = new Set(line.stages.map((s: any) => s.processCode)).size;
              return (
              <div key={line.lineKey} className="rounded-lg border border-border">
                <button type="button" onClick={() => toggleLine(line.lineKey)}
                  className="flex w-full flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 text-left hover:bg-muted/60">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    {isLineOpen ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                    {line.itemName || `Design #${line.itemNumber ?? '—'}`}
                    {line.colorModel && <Badge variant="secondary" className="ml-1"><Palette className="mr-1 size-3" />{line.colorModel}</Badge>}
                  </div>
                  <div className="flex items-center gap-2">
                    {!isLineOpen && furthest && (
                      <span className="hidden text-xs text-muted-foreground sm:inline">
                        {stepCount} step(s) · at {furthest.processName}
                      </span>
                    )}
                    {line.colorModelsAvailable > 0 && (
                      <Badge variant="info">{line.colorModelsAvailable} colour model(s)</Badge>
                    )}
                    <ProdStatus label={lineStatus} />
                  </div>
                </button>
                {isLineOpen && (
                <div className="overflow-x-auto">
                  <table className="w-full table-fixed text-sm" style={{ minWidth: 760 }}>
                    <colgroup>
                      <col style={{ width: '13%' }} />
                      <col style={{ width: '10%' }} />
                      <col style={{ width: '17%' }} />
                      <col style={{ width: '10%' }} />
                      <col style={{ width: '8%' }} />
                      <col style={{ width: '6%' }} />
                      <col style={{ width: '9%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '13%' }} />
                    </colgroup>
                    <thead className="bg-muted/40 text-left text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="whitespace-nowrap px-3 py-2 font-semibold">Process</th>
                        <th className="whitespace-nowrap px-3 py-2 font-semibold">Status</th>
                        <th className="whitespace-nowrap px-3 py-2 font-semibold">Vendor</th>
                        <th className="whitespace-nowrap px-3 py-2 font-semibold">Vendor Ref</th>
                        <th className="whitespace-nowrap px-3 py-2 font-semibold">Colour</th>
                        <th className="whitespace-nowrap px-3 py-2 font-semibold">Qty</th>
                        <th className="whitespace-nowrap px-3 py-2 font-semibold">Received</th>
                        <th className="whitespace-nowrap px-3 py-2 font-semibold">Pending / Fwd</th>
                        <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        // Group stages by process; multiple sends merge into one expandable row.
                        const groups: { code: string; name: string; stages: any[] }[] = [];
                        const idx = new Map<string, number>();
                        for (const st of line.stages) {
                          if (!idx.has(st.processCode)) { idx.set(st.processCode, groups.length); groups.push({ code: st.processCode, name: st.processName, stages: [] }); }
                          groups[idx.get(st.processCode)!].stages.push(st);
                        }
                        const lineCodes = Array.from(new Set(line.stages.map((s: any) => s.processCode))) as string[];
                        const rows: React.ReactNode[] = [];
                        for (const g of groups) {
                          if (g.stages.length === 1) { rows.push(stageRow(g.stages[0], false, lineCodes)); continue; }
                          const key = `${line.lineKey}:${g.code}`;
                          const isOpen = !!openGroups[key];
                          const totQ = g.stages.reduce((s, x) => s + x.quantity, 0);
                          const totR = g.stages.reduce((s, x) => s + x.receivedQty, 0);
                          const totF = g.stages.reduce((s, x) => s + x.forwardedQty, 0);
                          const vlist = Array.from(new Set(g.stages.map((x) => x.vendorName)));
                          const vendorLabel = vlist.length === 1 ? `${g.stages[0].vendorCode} · ${vlist[0]}` : `${vlist.length} vendors`;
                          rows.push(
                            <tr key={key} className="cursor-pointer border-t border-border bg-muted/20 hover:bg-muted/40" onClick={() => toggleGroup(key)}>
                              <td className="px-3 py-2"><Badge variant="default" className="whitespace-nowrap">{g.name}</Badge></td>
                              <td className="whitespace-nowrap px-3 py-2 text-xs font-medium text-primary">{isOpen ? '▾' : '▸'} {g.stages.length} issues</td>
                              <td className="truncate px-3 py-2 text-muted-foreground" title={vendorLabel}>{vendorLabel}</td>
                              <td className="px-3 py-2 text-muted-foreground">—</td>
                              <td className="px-3 py-2 text-muted-foreground">—</td>
                              <td className="px-3 py-2 font-semibold">{totQ}</td>
                              <td className="px-3 py-2 text-emerald-600">{totR}</td>
                              <td className="px-3 py-2">{totF > 0 ? <span className="text-sky-600">{totF} fwd</span> : '—'}</td>
                              <td className="px-3 py-2 text-right text-xs text-primary">{isOpen ? 'hide' : 'expand'}</td>
                            </tr>,
                          );
                          if (isOpen) g.stages.forEach((st) => rows.push(stageRow(st, true, lineCodes)));
                        }
                        return rows;
                      })()}
                    </tbody>
                  </table>
                </div>
                )}
              </div>
              );
            })}
          </div>

          {/* Materials to stick — grouped by vendor (sticking stages) — collapsed by default */}
          {!!(batch.materialByVendor && batch.materialByVendor.length) && (
            <details className="order-5 rounded-lg border border-border">
              <summary className="cursor-pointer select-none bg-muted/40 px-3 py-2 text-sm font-semibold">
                💎 Materials to Stick — by Vendor
              </summary>
              <div className="space-y-3 p-3">
              {batch.materialByVendor.map((vg: any) => (
                <div key={vg.vendorId} className="rounded-lg border border-border">
                  <div className="border-b border-border bg-muted/40 px-3 py-2 text-sm font-semibold">{vg.vendorCode} · {vg.vendorName}</div>
                  <div className="divide-y divide-border">
                    {vg.items.map((it: any) => (
                      <div key={it.batchItemId} className="px-3 py-2">
                        <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
                          <Badge variant="outline" className="font-semibold">#{it.itemNumber ?? '—'}</Badge>
                          {it.vendorDesignReference && <span className="font-medium">{it.vendorDesignReference}</span>}
                          {it.color && <Badge variant="info">{it.color}</Badge>}
                          <span className="text-muted-foreground">· {it.quantity} pcs</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {it.materials.map((m: any) => (
                            <Badge key={m.variantId} variant="secondary" className="font-normal">{m.variantName}: <span className="ml-1 font-semibold">{m.required} pcs</span></Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              </div>
            </details>
          )}

          {/* Inventory consumption check (sticking stages) — collapsed by default */}
          {!!(batch.materialRequirement && batch.materialRequirement.length) && (
            <details className="order-6 rounded-lg border border-border">
              <summary className="cursor-pointer select-none bg-muted/40 px-3 py-2 text-sm font-semibold">📦 Inventory Consumption (auto-deducted on Sticking)</summary>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5">Material</th>
                      <th className="px-3 py-1.5">By Design</th>
                      <th className="px-3 py-1.5">Total Required</th>
                      <th className="px-3 py-1.5">In Stock</th>
                      <th className="px-3 py-1.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batch.materialRequirement.map((m: any) => (
                      <tr key={m.variantId} className="border-t border-border align-top">
                        <td className="px-3 py-1.5"><span className="font-medium">{m.variantName}</span>{m.variantCode ? <span className="text-muted-foreground"> · {m.variantCode}</span> : ''}</td>
                        <td className="px-3 py-1.5">
                          <div className="flex flex-wrap gap-1">
                            {(m.byDesign ?? []).map((d: any) => (
                              <Badge key={d.itemNumber} variant="outline" className="text-xs">#{d.itemNumber}: <span className="ml-1 font-semibold">{d.qty}</span></Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-1.5 font-semibold">{m.required} pcs</td>
                        <td className="px-3 py-1.5">{Math.trunc(Number(m.stockQty))} pcs</td>
                        <td className="px-3 py-1.5">{m.short ? <Badge variant="destructive">Short stock</Badge> : <Badge variant="success">OK</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}

      <ForwardDialog stage={forwardStage} open={forwardStage != null} onClose={() => setForwardStage(null)} onDone={refresh} />
      <EditStageDialog stage={editStage} open={editStage != null} onClose={() => setEditStage(null)} onDone={refresh} />
    </Dialog>
  );
}
