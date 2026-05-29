'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft, Save, CheckCircle2, Plus, Trash2, FileUp, Star,
  Settings2, UploadCloud, Info, Eye, Boxes,
} from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Accordion, AccordionItem } from '@/components/ui/accordion';
import { Dialog } from '@/components/ui/dialog';
import { Field, SectionTitle } from '@/components/shared/field';
import { ImageUpload } from '@/components/shared/image-upload';
import { Spinner } from '@/components/ui/spinner';
import { cn, fileUrl, formatCurrency, SAMPLE_STATUS_LABELS } from '@/lib/utils';
import type { ItemMeta, Item } from '@/lib/types';

const schema = z.object({
  itemNumber: z.string().optional(),
  category: z.string().max(80).optional(),
  subcategory: z.string().max(80).optional(),
  collection: z.string().max(80).optional(),
  notes: z.string().optional(),
  designType: z.string().optional(),
  designerName: z.string().max(120).optional(),
  designerShortName: z.string().max(20).optional(),
  designCost: z.string().optional(),
  sellingPrice: z.string().optional(),
  sampleStatus: z.enum(['DRAFT', 'IN_DEVELOPMENT', 'SAMPLE_READY', 'PRODUCTION_READY']),
});
type FormValues = z.infer<typeof schema>;

interface FormVendor {
  vendorId: number; vendorDesignReference?: string; color?: string; colorPhotoPath?: string;
  costPerPiece?: string; isPreferred?: boolean; bringsOwnMaterials?: boolean; notes?: string;
}
interface ProcState {
  notes: string;
  attributes: Record<string, string>;
  photos: string[];
  vendors: FormVendor[];
  services: { serviceId: number; cost?: string }[];
}

const STEPS = ['design', 'basic', 'process'] as const;
type Step = (typeof STEPS)[number];
const STEP_LABEL: Record<Step, string> = { design: 'Design', basic: 'Basic Info', process: 'Processes' };

export function ItemForm({ itemId }: { itemId?: number }) {
  const router = useRouter();
  const qc = useQueryClient();
  const metaQ = useQuery<ItemMeta>({ queryKey: ['item-meta'], queryFn: () => Api.items.meta() });

  const [step, setStep] = React.useState<Step>('design');
  const [existingImages, setExistingImages] = React.useState<{ id: number; path: string }[]>([]);
  const [imagePaths, setImagePaths] = React.useState<string[]>([]);
  const [cadPath, setCadPath] = React.useState<string | undefined>();
  const [cadUploading, setCadUploading] = React.useState(false);
  const [cadViewerOpen, setCadViewerOpen] = React.useState(false);
  const [procState, setProcState] = React.useState<Record<number, ProcState>>({});
  const [sampleCode, setSampleCode] = React.useState<string>('');
  // BOM rows (materials stuck onto the design — defined under Sticking).
  const [bom, setBom] = React.useState<{ variantId: number | ''; quantity: string; notes: string; color?: string }[]>([]);

  const {
    register, handleSubmit, reset, watch, setValue,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { sampleStatus: 'DRAFT' } });

  const designers = metaQ.data?.designers ?? [];
  const services = metaQ.data?.services ?? [];
  const variants = metaQ.data?.variants ?? [];
  const shortName = watch('designerShortName');
  const designCostNum = Number(watch('designCost') || 0);
  // Item Master excludes Design/CAD (handled above) and batch-only processes (e.g. Antique).
  const processSections = (metaQ.data?.processes ?? []).filter((p) => p.code !== 'DESIGN_CAD' && !p.batchOnly);

  // Colour code resets PER PROCESS: each colour process letters its own colours a/b/c.
  const itemNumberVal = watch('itemNumber');
  const colourLetterMap = React.useMemo(() => {
    const m = new Map<string, string>(); // `${processId}:${name}` -> letter
    for (const p of processSections) {
      if (!p.usesColor) continue;
      let i = 0;
      for (const v of procState[p.id]?.vendors ?? []) {
        const nm = (v.color ?? '').trim();
        if (!nm) continue;
        const key = `${p.id}:${nm.toLowerCase()}`;
        if (!m.has(key)) { m.set(key, String.fromCharCode(97 + i)); i++; }
      }
    }
    return m;
  }, [processSections, procState]);
  const colourCode = (pid: number, name?: string) => {
    const nm = (name ?? '').trim();
    const letter = nm ? colourLetterMap.get(`${pid}:${nm.toLowerCase()}`) : undefined;
    if (!itemNumberVal || !letter) return '';
    return `${itemNumberVal}(${letter})-${nm}`;
  };

  // A single BOM material row (reused inline under each sticking colour).
  const bomRowJSX = (b: (typeof bom)[number], idx: number) => {
    const v = variants.find((x) => x.id === Number(b.variantId));
    const line = v ? (v.price || 0) * Number(b.quantity || 0) : 0;
    const setBomRow = (patch: any) => setBom((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    return (
      <div key={idx} className="rounded-lg border border-border bg-card p-2.5">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
          <div className="sm:col-span-5">
            <Field label="Material Variant">
              <SearchableSelect
                value={b.variantId}
                placeholder="— Select material —"
                onChange={(val) => setBomRow({ variantId: val ? Number(val) : '' })}
                options={variants.map((vo) => ({
                  value: vo.id,
                  label: `${vo.variantName}${vo.size ? ` · ${vo.size}` : ''}${vo.color ? ` · ${vo.color}` : ''} (stock ${vo.stockQty})`,
                  keywords: `${vo.materialName ?? ''} ${vo.variantCode ?? ''}`,
                }))}
              />
            </Field>
          </div>
          <div className="sm:col-span-2"><Field label="Qty / piece" hint="whole number"><Input type="number" step="1" min="0" value={b.quantity} onChange={(e) => setBomRow({ quantity: e.target.value.replace(/[^0-9]/g, '') })} /></Field></div>
          <div className="sm:col-span-4"><Field label="Notes"><Input value={b.notes} onChange={(e) => setBomRow({ notes: e.target.value })} /></Field></div>
          <div className="sm:col-span-1 flex items-end">
            <Button type="button" variant="outline" size="icon" className="mb-0.5 text-destructive hover:bg-destructive/10" onClick={() => setBom((rs) => rs.filter((_, i) => i !== idx))}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
        {v && <div className="mt-1 text-xs text-muted-foreground">Price/pc: <strong className="text-foreground">{formatCurrency(v.price)}</strong> · Line cost: <strong className="text-foreground">{formatCurrency(line)}</strong></div>}
      </div>
    );
  };

  // Load existing item (edit).
  React.useEffect(() => {
    if (!itemId) return;
    Api.items.get(itemId).then((it: Item) => {
      reset({
        itemNumber: it.itemNumber != null ? String(it.itemNumber) : '',
        category: it.category ?? '', subcategory: it.subcategory ?? '', collection: it.collection ?? '',
        notes: it.notes ?? '', designType: it.designType ?? '',
        designerName: it.designerName ?? '', designerShortName: it.designerShortName ?? '',
        designCost: it.designCost != null ? String(it.designCost) : '',
        sellingPrice: it.sellingPrice != null ? String(it.sellingPrice) : '',
        sampleStatus: it.sampleStatus,
      });
      setSampleCode(it.sampleDesignCode);
      setExistingImages(it.images.map((im) => ({ id: im.id, path: im.filePath })));
      setImagePaths(it.images.map((im) => im.filePath));
      setCadPath(it.cadFilePath ?? undefined);
      const ps: Record<number, ProcState> = {};
      it.processes.forEach((p) => {
        ps[p.processId] = {
          notes: p.notes ?? '',
          attributes: p.attributes ?? {},
          photos: (p.photos ?? []).map((ph) => ph.filePath!).filter(Boolean),
          vendors: (p.vendors ?? []).map((v) => ({
            vendorId: v.vendorId, vendorDesignReference: v.vendorDesignReference ?? '',
            color: v.color ?? '', colorPhotoPath: (v as any).colorPhotoPath ?? undefined,
            costPerPiece: v.costPerPiece != null ? String(v.costPerPiece) : '',
            isPreferred: v.isPreferred ?? false,
            bringsOwnMaterials: (v as any).bringsOwnMaterials ?? false,
            notes: v.notes ?? '',
          })),
          services: (p.services ?? []).map((s) => ({ serviceId: s.serviceId, cost: s.cost != null ? String(s.cost) : '' })),
        };
      });
      setProcState(ps);
      setBom((it.materials ?? []).map((m) => ({
        variantId: m.variantId, quantity: String(m.quantity),
        notes: m.notes ?? '',
        color: (m as any).stickingColor ?? undefined,
      })));
    });
  }, [itemId, reset]);

  // Preview the auto sample code (create mode) as short name changes.
  React.useEffect(() => {
    if (itemId) return;
    const sn = (shortName || '').trim();
    let active = true;
    Api.items.nextDesignCode(sn || undefined).then((r) => { if (active) setSampleCode(r.sampleDesignCode); }).catch(() => {});
    return () => { active = false; };
  }, [shortName, itemId]);

  const getProc = (pid: number): ProcState =>
    procState[pid] ?? { notes: '', attributes: {}, photos: [], vendors: [], services: [] };
  const setProc = (pid: number, patch: Partial<ProcState>) =>
    setProcState((s) => ({ ...s, [pid]: { ...getProc(pid), ...patch } }));
  const vendorOptionsFor = (pid: number) => metaQ.data?.processes.find((p) => p.id === pid)?.vendors ?? [];
  const updateVendor = (pid: number, idx: number, patch: Partial<FormVendor>) => {
    const st = getProc(pid);
    setProc(pid, { vendors: st.vendors.map((v, i) => (i === idx ? { ...v, ...patch } : v)) });
  };

  // Add a new service to the master (e.g. a new Casting service) on the fly.
  const addService = useMutation({
    mutationFn: (body: { name: string; appliesTo?: string }) => Api.createService(body),
    onSuccess: (svc: any) => {
      toast.success(`Service "${svc.name}" added.`);
      qc.invalidateQueries({ queryKey: ['item-meta'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const promptAddService = (appliesTo: string) => {
    const name = window.prompt('New service name (e.g. Polishing):')?.trim();
    if (name) addService.mutate({ name, appliesTo });
  };

  // The PREFERRED (★) sticking colour — its BOM represents the item's material cost.
  const prefStickColour = React.useMemo(() => {
    const st = processSections.find((p) => p.code === 'STICKING');
    const vs = st ? (procState[st.id]?.vendors ?? []) : [];
    return ((vs.find((v) => v.isPreferred) ?? vs[0])?.color ?? '').trim();
  }, [processSections, procState]);

  // Material cost = the preferred sticking colour's BOM only.
  const bomCost = React.useMemo(
    () =>
      bom.reduce((s, b) => {
        if ((b.color ?? '').trim() !== prefStickColour) return s;
        const v = variants.find((x) => x.id === Number(b.variantId));
        return v ? s + (v.price || 0) * Number(b.quantity || 0) : s;
      }, 0),
    [bom, variants, prefStickColour],
  );

  // Live cost price = design + services + per-process preferred + preferred-colour BOM.
  const costPrice = React.useMemo(() => {
    const casting = processSections.find((p) => p.code === 'CASTING');
    const weightG = casting ? Number(procState[casting.id]?.attributes?.weight || 0) : 0;
    let total = designCostNum;
    for (const p of processSections) {
      const st = procState[p.id];
      if (!st) continue;
      total += (st.services ?? []).reduce((s, sv) => s + Number(sv.cost || 0), 0);
      const entries = st.vendors.filter((v) => v.vendorId > 0);
      if (!entries.length) continue;
      const chosen = entries.find((e) => e.isPreferred) ?? entries.find((e) => e.costPerPiece) ?? entries[0];
      const rate = Number(chosen.costPerPiece || 0);
      total += p.costUnit === 'KG' ? (weightG / 1000) * rate : rate;
    }
    total += bomCost; // preferred sticking colour's materials
    return Math.round(total * 100) / 100;
  }, [procState, designCostNum, processSections, bomCost]);

  // Itemised cost breakup (mirrors the live cost price) for the Basic Info panel.
  const costLines = React.useMemo(() => {
    const casting = processSections.find((p) => p.code === 'CASTING');
    const weightG = casting ? Number(procState[casting.id]?.attributes?.weight || 0) : 0;
    const lines: { label: string; amount: number }[] = [];
    if (designCostNum) lines.push({ label: 'Design cost', amount: designCostNum });
    for (const p of processSections) {
      const st = procState[p.id];
      if (!st) continue;
      const entries = st.vendors.filter((v) => v.vendorId > 0);
      if (entries.length) {
        const chosen = entries.find((e) => e.isPreferred) ?? entries.find((e) => e.costPerPiece) ?? entries[0];
        const rate = Number(chosen.costPerPiece || 0);
        const amt = p.costUnit === 'KG' ? (weightG / 1000) * rate : rate;
        if (amt) lines.push({ label: `${p.name}${p.costUnit === 'KG' ? ' (per kg)' : ''}`, amount: Math.round(amt * 100) / 100 });
      }
      const svc = (st.services ?? []).reduce((s, sv) => s + Number(sv.cost || 0), 0);
      if (svc) lines.push({ label: `${p.name} — services`, amount: svc });
    }
    if (bomCost) lines.push({ label: `Sticking materials${prefStickColour ? ` (${prefStickColour})` : ''}`, amount: Math.round(bomCost * 100) / 100 });
    return lines;
  }, [procState, designCostNum, processSections, bomCost, prefStickColour]);

  const existingPathSet = new Set(existingImages.map((i) => i.path));
  const newImagePaths = imagePaths.filter((p) => !existingPathSet.has(p));

  const buildPayload = (values: FormValues, forceDraft: boolean) => ({
    ...values,
    itemNumber: values.itemNumber ? String(values.itemNumber).trim() : undefined,
    designType: values.designType || undefined,
    designCost: values.designCost ? Number(values.designCost) : undefined,
    sellingPrice: values.sellingPrice ? Number(values.sellingPrice) : undefined,
    sampleStatus: forceDraft ? 'DRAFT' : values.sampleStatus,
    cadFilePath: cadPath,
    images: imagePaths,
    processes: processSections.map((p) => {
      const st = getProc(p.id);
      return {
        processId: p.id,
        notes: st.notes || undefined,
        attributes: st.attributes,
        photos: st.photos,
        services: (st.services ?? []).map((s) => ({ serviceId: s.serviceId, cost: s.cost ? Number(s.cost) : undefined })),
        vendors: st.vendors.filter((v) => v.vendorId > 0).map((v) => ({
          vendorId: Number(v.vendorId),
          vendorDesignReference: v.vendorDesignReference || undefined,
          color: v.color || undefined,
          colorPhotoPath: v.colorPhotoPath || undefined,
          costPerPiece: v.costPerPiece !== undefined && v.costPerPiece !== '' ? Number(v.costPerPiece) : undefined,
          isPreferred: !!v.isPreferred,
          bringsOwnMaterials: !!v.bringsOwnMaterials,
          notes: v.notes || undefined,
        })),
      };
    }),
    materials: bom
      .filter((b) => b.variantId)
      .map((b) => ({
        variantId: Number(b.variantId),
        quantity: Math.max(0, Math.trunc(Number(b.quantity || 0))), // whole number — never fractions

        color: b.color || undefined,
        notes: b.notes || undefined,
      })),
  });

  const save = useMutation({
    mutationFn: (body: any) => (itemId ? Api.items.update(itemId, body) : Api.items.create(body)),
    onSuccess: (res: any) => {
      toast.success(itemId ? 'Item saved.' : `Item ${res.sampleDesignCode} created.`);
      qc.invalidateQueries({ queryKey: ['items'] });
      router.push(`/items/${res.id}`);
    },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const submit = (forceDraft: boolean) => handleSubmit((v) => save.mutate(buildPayload(v, forceDraft)))();

  const deleteExistingImage = async (img: { id: number; path: string }) => {
    if (itemId) await Api.items.deleteImage(itemId, img.id);
    setExistingImages((arr) => arr.filter((i) => i.id !== img.id));
    setImagePaths((arr) => arr.filter((p) => p !== img.path));
    toast.success('Image removed.');
  };

  const cadInput = React.useRef<HTMLInputElement>(null);
  const onCadFile = async (file?: File) => {
    if (!file) return;
    setCadUploading(true);
    try {
      const res = await Api.upload(file, 'cad', 'cad');
      setCadPath(res.path);
      toast.success('CAD file uploaded.');
    } catch (e) { toast.error(getApiError(e).message); } finally { setCadUploading(false); }
  };

  const onPickDesigner = (vendorId: string) => {
    const d = designers.find((x) => String(x.id) === vendorId);
    if (d) {
      setValue('designerName', d.vendorName);
      setValue('designerShortName', d.shortName ?? '');
    }
  };

  return (
    <div className="relative pb-24">
      {/* Full-form blocking overlay while save is in flight — disables every input
          and shows a spinner so the user can't double-submit or edit mid-save. */}
      {save.isPending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
          <div className="flex items-center gap-3 rounded-lg bg-card px-5 py-3 text-sm shadow-xl">
            <Spinner className="text-primary" />
            <span className="font-medium">Saving item — please wait…</span>
          </div>
        </div>
      )}
      <fieldset disabled={save.isPending} className={save.isPending ? 'pointer-events-none' : ''}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{itemId ? 'Edit Item' : 'Create Item'}</h1>
          <p className="text-sm text-muted-foreground">Design → Basic Info → Processes. Save anytime as a draft.</p>
        </div>
        <Button variant="outline" onClick={() => router.push('/items')}><ArrowLeft className="size-4" /> Back to list</Button>
      </div>

      <div className="mb-4 flex gap-2 overflow-x-auto">
        {STEPS.map((s, i) => (
          <button key={s} onClick={() => setStep(s)}
            className={cn('whitespace-nowrap rounded-md border px-4 py-2 text-sm font-medium transition-colors',
              step === s ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-accent')}>
            {i + 1}. {STEP_LABEL[s]}
          </button>
        ))}
      </div>

      {/* Step 1: Design */}
      {step === 'design' && (
        <Card><CardContent className="p-5">
          <SectionTitle><FileUp className="size-4" /> Design / CAD Section</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Design Type">
              <Select {...register('designType')}>
                <option value="">— Select —</option>
                <option value="CAD">CAD</option>
                <option value="HANDMADE">Handmade</option>
              </Select>
            </Field>
            <Field label="Designer"
              hint={designers.length ? 'Designers are vendors with the Design/CAD process.' : 'Add a Design/CAD vendor (with a short name) first.'}>
              <SearchableSelect
                value={designers.find((d) => d.vendorName === watch('designerName'))?.id ?? ''}
                placeholder="— Select designer —"
                onChange={(v) => onPickDesigner(v)}
                options={designers.map((d) => ({ value: d.id, label: `${d.vendorName}${d.shortName ? ` (${d.shortName})` : ''}`, keywords: d.shortName ?? '' }))}
              />
            </Field>
            <Field label="Designer Short Name" hint="Drives the sample design code (e.g. TVM → TVM-001).">
              <Input placeholder="e.g. TVM" {...register('designerShortName')} />
            </Field>
            <Field label="Design Cost"><Input type="number" step="0.01" {...register('designCost')} /></Field>
            <Field label="Sample Status">
              <Select {...register('sampleStatus')}>
                {Object.entries(SAMPLE_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="CAD File" hint="Opens in a viewer (not downloaded). STL / OBJ / 3DM / ZIP / PDF / image.">
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" onClick={() => cadInput.current?.click()} disabled={cadUploading}>
                  {cadUploading ? <Spinner /> : <UploadCloud className="size-4" />} Upload CAD
                </Button>
                {cadPath && <Button type="button" variant="outline" onClick={() => setCadViewerOpen(true)}><Eye className="size-4" /> View</Button>}
                <input ref={cadInput} type="file" className="hidden" onChange={(e) => onCadFile(e.target.files?.[0])} />
              </div>
            </Field>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Sample Design Code will be <span className="font-semibold text-foreground">{sampleCode || '—'}</span>
          </p>
        </CardContent></Card>
      )}

      {/* Step 2: Basic Info */}
      {step === 'basic' && (
        <Card><CardContent className="p-5">
          <SectionTitle><Info className="size-4" /> Basic Item Info</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Sample Design Code" hint="Auto-generated from designer short name.">
              <Input readOnly disabled value={sampleCode} className="bg-muted font-semibold" />
            </Field>
            <Field label="Item Number" hint="Alphanumeric, unique (e.g. 1501 or 1501a)">
              <Input type="text" maxLength={40} {...register('itemNumber')} />
            </Field>
            <Field label="Sample Status">
              <Select {...register('sampleStatus')}>
                {Object.entries(SAMPLE_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Category"><Input {...register('category')} /></Field>
            <Field label="Subcategory"><Input {...register('subcategory')} /></Field>
            <Field label="Collection"><Input {...register('collection')} /></Field>
            <Field label="Selling Price"><Input type="number" step="0.01" {...register('sellingPrice')} /></Field>
            <Field label="Cost Price" hint="Auto-calculated from design + process costs.">
              <Input readOnly disabled value={formatCurrency(costPrice)} className="bg-muted font-semibold" />
            </Field>
          </div>

          {/* Live cost-price breakup */}
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-4">
            <div className="mb-2 text-sm font-semibold">Cost Price Breakup</div>
            {costLines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add design cost / process rates / materials to see the breakup.</p>
            ) : (
              <div className="space-y-1 text-sm">
                {costLines.map((l, i) => (
                  <div key={i} className="flex justify-between border-b border-border/60 py-1 last:border-0">
                    <span className="text-muted-foreground">{l.label}</span>
                    <span className="font-medium">{formatCurrency(l.amount)}</span>
                  </div>
                ))}
                <div className="flex justify-between pt-1.5 text-base font-bold text-primary">
                  <span>Total Cost Price</span><span>{formatCurrency(costPrice)}</span>
                </div>
                {Number(watch('sellingPrice') || 0) > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Margin at selling price</span>
                    <span>{formatCurrency(Number(watch('sellingPrice') || 0) - costPrice)}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <SectionTitle><UploadCloud className="size-4" /> Product Photos</SectionTitle>
          {existingImages.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {existingImages.map((img) => (
                <div key={img.id} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={fileUrl(img.path)} alt="" className="size-20 rounded-lg border border-border object-cover" />
                  <button type="button" onClick={() => deleteExistingImage(img)}
                    className="absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full border-2 border-card bg-destructive text-destructive-foreground">
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <ImageUpload module="items" multiple value={newImagePaths}
            onChange={(paths) => setImagePaths([...existingImages.map((i) => i.path), ...paths])} />

          <SectionTitle><Info className="size-4" /> Notes</SectionTitle>
          <Textarea rows={3} placeholder="General notes about this design…" {...register('notes')} />
        </CardContent></Card>
      )}

      {/* Step 3: Processes */}
      {step === 'process' && (
        <Card><CardContent className="p-5">
          <SectionTitle><Settings2 className="size-4" /> Manufacturing / Job-Work Processes</SectionTitle>
          <p className="mb-4 text-sm text-muted-foreground">
            Casting &amp; Plating &amp; Meena are priced per KG. Plating &amp; Meena allow the same vendor in multiple colours.
          </p>
          <Accordion>
            {processSections.map((p) => {
              const st = getProc(p.id);
              const procVendors = vendorOptionsFor(p.id);
              const rateLabel = p.costUnit === 'KG' ? 'Cost / KG' : 'Cost / Piece';
              const procServices = services.filter((s) => !s.appliesTo || s.appliesTo === p.code);
              return (
                <AccordionItem key={p.id}
                  title={<><Settings2 className="size-4" /> {p.name} {p.costUnit === 'KG' && <Badge variant="info">per KG</Badge>}</>}
                  badge={<Badge variant="secondary">{st.vendors.length} {p.usesColor ? 'colour(s)' : 'vendor(s)'}</Badge>}>

                  {p.attributes.length > 0 && (
                    <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                      {p.attributes.map((a) => (
                        <Field key={a.key} label={a.label}>
                          <Input value={st.attributes[a.key] ?? ''}
                            onChange={(e) => setProc(p.id, { attributes: { ...st.attributes, [a.key]: e.target.value } })} />
                        </Field>
                      ))}
                    </div>
                  )}

                  {/* Optional services (e.g. Casting → Soldering / Fitting) */}
                  {p.usesServices && (
                    <div className="mb-3">
                      <div className="mb-1 flex items-center justify-between">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Optional Services <span className="font-normal normal-case">(cost is per piece)</span>
                        </div>
                        <button type="button"
                          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-50"
                          onClick={() => promptAddService(p.code)} disabled={addService.isPending}>
                          <Plus className="size-3" /> Add service
                        </button>
                      </div>
                      {procServices.length === 0 && (
                        <p className="mb-2 text-xs text-muted-foreground">No services yet — use “Add service”.</p>
                      )}
                      <div className="flex flex-wrap gap-3">
                        {procServices.map((sv) => {
                          const sel = st.services.find((x) => x.serviceId === sv.id);
                          const toggle = () => {
                            const next = sel
                              ? st.services.filter((x) => x.serviceId !== sv.id)
                              : [...st.services, { serviceId: sv.id, cost: '' }];
                            setProc(p.id, { services: next });
                          };
                          return (
                            <div key={sv.id} className="rounded-md border border-border px-2.5 py-1.5">
                              <label className="flex cursor-pointer items-center gap-2">
                                <input type="checkbox" className="accent-primary" checked={!!sel} onChange={toggle} />
                                <span className="text-sm">{sv.name}</span>
                              </label>
                              {sel && (
                                <div className="mt-1.5 flex items-center gap-1">
                                  <span className="text-xs text-muted-foreground">₹/pc</span>
                                  <Input type="number" step="0.01" placeholder="rate per piece" className="h-7 w-28"
                                    value={sel.cost ?? ''}
                                    onChange={(e) => setProc(p.id, {
                                      services: st.services.map((x) => x.serviceId === sv.id ? { ...x, cost: e.target.value } : x),
                                    })} />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Notes + Photos side-by-side on desktop, stacked on mobile */}
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Field label="Process Notes">
                      <Textarea rows={4} value={st.notes} onChange={(e) => setProc(p.id, { notes: e.target.value })} />
                    </Field>
                    <Field label="Process Photos" hint="Development / progress / before-after.">
                      <ImageUpload module="items" multiple value={st.photos} onChange={(paths) => setProc(p.id, { photos: paths })} />
                    </Field>
                  </div>

                  <div className="mt-4">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {p.usesColor ? 'Colours for this process' : 'Vendors for this process'}
                    </span>
                  </div>

                  {procVendors.length === 0 ? (
                    <div className="mt-2 flex flex-col items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                      <span>No vendors support <strong>{p.name}</strong> yet.</span>
                      <Link href="/vendors"><Button type="button" variant="outline" size="sm"><Plus className="size-4" /> Add Vendor in Vendor Master</Button></Link>
                    </div>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {st.vendors.map((v, idx) => (
                        <div key={idx} className="rounded-lg border border-border bg-muted/30 p-3">
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                            <div className="sm:col-span-3">
                              <Field label="Vendor">
                                <SearchableSelect
                                  value={v.vendorId || ''}
                                  placeholder="— Select —"
                                  onChange={(val) => updateVendor(p.id, idx, { vendorId: Number(val) })}
                                  options={procVendors.map((vo) => ({ value: vo.id, label: `${vo.vendorCode} · ${vo.vendorName}`, keywords: vo.vendorName }))}
                                />
                              </Field>
                            </div>
                            {p.usesColor && (
                              <div className="sm:col-span-2">
                                <Field label="Colour"><Input placeholder="e.g. Gold" value={v.color ?? ''} onChange={(e) => updateVendor(p.id, idx, { color: e.target.value })} /></Field>
                              </div>
                            )}
                            <div className={p.usesColor ? 'sm:col-span-2' : 'sm:col-span-3'}>
                              <Field label="Vendor Design Ref."><Input placeholder="e.g. CST-88" value={v.vendorDesignReference ?? ''} onChange={(e) => updateVendor(p.id, idx, { vendorDesignReference: e.target.value })} /></Field>
                            </div>
                            <div className="sm:col-span-2">
                              <Field label={rateLabel}><Input type="number" step="0.01" value={v.costPerPiece ?? ''} onChange={(e) => updateVendor(p.id, idx, { costPerPiece: e.target.value })} /></Field>
                            </div>
                            <div className={p.usesColor ? 'sm:col-span-2' : 'sm:col-span-3'}>
                              <Field label="Notes"><Input value={v.notes ?? ''} onChange={(e) => updateVendor(p.id, idx, { notes: e.target.value })} /></Field>
                            </div>
                            <div className="flex items-end justify-between gap-2 sm:col-span-1">
                              <label className="flex items-center gap-1 pb-2 text-sm" title="Preferred">
                                <input type="checkbox" className="accent-primary" checked={!!v.isPreferred} onChange={(e) => updateVendor(p.id, idx, { isPreferred: e.target.checked })} />
                                <Star className="size-3.5" />
                              </label>
                              <Button type="button" variant="outline" size="icon" className="mb-0.5 text-destructive hover:bg-destructive/10"
                                onClick={() => setProc(p.id, { vendors: st.vendors.filter((_, i) => i !== idx) })}>
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          </div>
                          {p.code === 'STICKING' && (
                            <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-md border border-sky-200 bg-sky-50/60 px-2.5 py-1.5 text-xs text-sky-900">
                              <input type="checkbox" className="size-3.5 accent-primary" checked={!!v.bringsOwnMaterials}
                                onChange={(e) => updateVendor(p.id, idx, { bringsOwnMaterials: e.target.checked })} />
                              <span><strong>This vendor brings their own raw materials.</strong> Their per-piece rate covers materials — BOM cost is excluded from cost price and no material issue is auto-created on forward.</span>
                            </label>
                          )}
                          {p.usesColor && (
                            <div className="mt-2 grid grid-cols-1 gap-3 border-t border-border pt-2 sm:grid-cols-2">
                              <div className="flex items-center gap-2 text-sm">
                                <span className="text-muted-foreground">Colour code:</span>
                                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold">{colourCode(p.id, v.color) || (itemNumberVal ? '—' : 'set item number')}</code>
                              </div>
                              <Field label="Colour photo">
                                <ImageUpload module="items" value={v.colorPhotoPath ? [v.colorPhotoPath] : []} onChange={(paths) => updateVendor(p.id, idx, { colorPhotoPath: paths[0] })} />
                              </Field>
                            </div>
                          )}
                          {/* This colour's own BOM (Sticking) — 1 colour = 1 BOM */}
                          {p.code === 'STICKING' && (
                            <div className="mt-2 rounded-md border border-primary/20 bg-primary/5 p-2.5">
                              <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-primary">
                                <Boxes className="size-4" /> BOM for {v.color || 'this colour'}{colourCode(p.id, v.color) ? ` · ${colourCode(p.id, v.color)}` : ''}
                              </div>
                              {variants.length === 0 ? (
                                <p className="text-xs text-amber-700">Add material variants in <Link href="/materials" className="underline">Material Variants</Link> first.</p>
                              ) : (
                                <>
                                  <div className="space-y-2">
                                    {bom.map((b, bidx) => ((b.color ?? '') === (v.color ?? '') ? bomRowJSX(b, bidx) : null))}
                                  </div>
                                  <Button type="button" variant="outline" size="sm" className="mt-2"
                                    onClick={() => setBom((rs) => [...rs, { variantId: '', quantity: '', notes: '', color: v.color || undefined }])}>
                                    <Plus className="size-4" /> Add Material
                                  </Button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                      {st.vendors.length === 0 && (
                        <p className="text-sm text-muted-foreground">None added — click below.</p>
                      )}
                      <Button type="button" variant="outline" size="sm"
                        onClick={() => setProc(p.id, { vendors: [...st.vendors, { vendorId: 0 }] })}>
                        <Plus className="size-4" /> {p.usesColor ? 'Add Colour' : 'Add Vendor'}
                      </Button>
                    </div>
                  )}

                </AccordionItem>
              );
            })}
          </Accordion>
        </CardContent></Card>
      )}

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 px-4 py-3 backdrop-blur lg:pl-64">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">
            Cost: <strong className="text-foreground">{formatCurrency(costPrice)}</strong>
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {STEPS.indexOf(step) > 0 && <Button variant="outline" onClick={() => setStep(STEPS[STEPS.indexOf(step) - 1])}>Previous</Button>}
            {STEPS.indexOf(step) < STEPS.length - 1 && <Button variant="outline" onClick={() => setStep(STEPS[STEPS.indexOf(step) + 1])}>Next</Button>}
            <span className="mx-1 hidden h-6 w-px bg-border sm:inline-block" />
            <Button variant="secondary" onClick={() => submit(true)} disabled={save.isPending}>
              {save.isPending && <Spinner />} <Save className="size-4" /> Save Draft
            </Button>
            <Button onClick={() => submit(false)} disabled={save.isPending}>
              {save.isPending && <Spinner />} <CheckCircle2 className="size-4" /> Save Item
            </Button>
          </div>
        </div>
      </div>

      {/* CAD viewer modal */}
      <Dialog open={cadViewerOpen} onClose={() => setCadViewerOpen(false)} size="xl" title="CAD File Preview">
        {cadPath ? (
          <div className="space-y-2">
            <iframe src={fileUrl(cadPath)} className="h-[70vh] w-full rounded-md border border-border" title="CAD preview" />
            <a href={fileUrl(cadPath)} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">Open in new tab</a>
          </div>
        ) : <p className="text-sm text-muted-foreground">No CAD file.</p>}
      </Dialog>
      </fieldset>
    </div>
  );
}
