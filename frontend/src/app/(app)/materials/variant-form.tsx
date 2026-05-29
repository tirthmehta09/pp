'use client';

import * as React from 'react';
import { useFieldArray, useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Info, Ruler, ImageIcon, Users } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Field, SectionTitle } from '@/components/shared/field';
import { ImageUpload } from '@/components/shared/image-upload';
import { Spinner } from '@/components/ui/spinner';
import type { Category, MaterialVariant, VendorLite } from '@/lib/types';

const vendorSchema = z.object({
  vendorId: z.coerce.number().min(1, 'Select a vendor'),
  vendorReference: z.string().max(80).optional().or(z.literal('')),
  price: z.coerce.number().optional().or(z.nan()),
  moq: z.coerce.number().optional().or(z.nan()),
  notes: z.string().optional().or(z.literal('')),
  isPreferred: z.boolean().optional(),
});

const schema = z.object({
  materialName: z.string().min(1, 'Material name is required').max(150),
  categoryId: z.string().optional(),
  variantName: z.string().min(1, 'Variant name is required').max(150),
  size: z.string().min(1, 'Size is required'),
  color: z.string().min(1, 'Colour is required'),
  finish: z.string().optional(),
  shape: z.string().optional(),
  unit: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  vendors: z.array(vendorSchema).min(1, 'Add at least one supplier'),
});
type FormValues = z.infer<typeof schema>;

export function VariantForm({
  open,
  onClose,
  variantId,
}: {
  open: boolean;
  onClose: () => void;
  variantId: number | null;
}) {
  const qc = useQueryClient();
  const [imagePaths, setImagePaths] = React.useState<string[]>([]);

  const categoriesQ = useQuery<Category[]>({
    queryKey: ['categories'], queryFn: () => Api.materials.categories(), enabled: open,
  });
  // Material variants are supplied by Raw Material Suppliers only — restrict the
  // vendor dropdown to vendors tagged with that role.
  const processesQ = useQuery({ queryKey: ['processes'], queryFn: () => Api.processes(), enabled: open });
  const supplierProcessId = (processesQ.data ?? []).find((p: any) => p.isSupplier)?.id;
  const vendorsQ = useQuery<VendorLite[]>({
    queryKey: ['suppliers-lite', supplierProcessId],
    queryFn: () => Api.vendors.list({ status: 'ACTIVE', processId: supplierProcessId }),
    enabled: open && !!supplierProcessId,
  });

  const {
    register, handleSubmit, reset, control, watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { status: 'ACTIVE', vendors: [] },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'vendors' });

  // Live generated code: supplierShort-Material-Size-Colour (blank segments skipped).
  const wMaterial = watch('materialName');
  const wSize = watch('size');
  const wColor = watch('color');
  const wVendors = watch('vendors');
  const supplierVendor = (wVendors ?? []).find((v) => v.isPreferred) ?? (wVendors ?? [])[0];
  const supplierShort = (vendorsQ.data ?? []).find((v) => v.id === Number(supplierVendor?.vendorId))?.shortName ?? '';
  const genCode = [supplierShort, wMaterial, wSize, wColor]
    .map((s) => (s ?? '').toString().trim().replace(/\s+/g, ''))
    .filter(Boolean)
    .join('-');

  React.useEffect(() => {
    if (!open) return;
    if (variantId) {
      Api.materials.getVariant(variantId).then((v: MaterialVariant) => {
        reset({
          materialName: v.materialName,
          categoryId: v.categoryId ? String(v.categoryId) : '',
          variantName: v.variantName,
          size: v.size ?? '', color: v.color ?? '', finish: v.finish ?? '',
          shape: v.shape ?? '', unit: v.unit ?? '', notes: v.notes ?? '',
          status: v.status,
          vendors: (v.vendors ?? []).map((vv) => ({
            vendorId: vv.vendorId,
            vendorReference: vv.vendorReference ?? '',
            price: vv.price ?? (undefined as any),
            moq: vv.moq ?? (undefined as any),
            notes: vv.notes ?? '',
            isPreferred: vv.isPreferred ?? false,
          })),
        });
        setImagePaths(v.imagePath ? [v.imagePath] : []);
      });
    } else {
      reset({ status: 'ACTIVE', materialName: '', variantName: '', vendors: [] });
      setImagePaths([]);
    }
  }, [open, variantId, reset]);

  const mutation = useMutation({
    mutationFn: (values: FormValues) => {
      const body = {
        ...values,
        categoryId: values.categoryId ? Number(values.categoryId) : undefined,
        imagePath: imagePaths[0],
        vendors: values.vendors
          .filter((v) => v.vendorId > 0)
          .map((v) => ({
            vendorId: Number(v.vendorId),
            vendorReference: v.vendorReference || undefined,
            price: Number.isNaN(v.price as any) ? undefined : v.price,
            moq: Number.isNaN(v.moq as any) ? undefined : v.moq,
            notes: v.notes || undefined,
            isPreferred: !!v.isPreferred,
          })),
      };
      return variantId
        ? Api.materials.updateVariant(variantId, body)
        : Api.materials.createVariant(body);
    },
    onSuccess: () => {
      toast.success(variantId ? 'Variant updated.' : 'Variant created.');
      qc.invalidateQueries({ queryKey: ['variants'] });
      qc.invalidateQueries({ queryKey: ['materials-list'] });
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={variantId ? 'Edit Material Variant' : 'Add Material Variant'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
          <Button form="variantForm" type="submit" disabled={isSubmitting}>
            {isSubmitting && <Spinner />} Save Variant
          </Button>
        </>
      }
    >
      <form id="variantForm" onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-5">
        <div>
          <SectionTitle><Info className="size-4" /> Basic Information</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Material Name" required error={errors.materialName?.message}
              hint="Type a new name to create a material, or pick an existing one.">
              <Input list="materialDatalist" {...register('materialName')} />
              <MaterialDatalist />
            </Field>
            <Field label="Category">
              <Controller name="categoryId" control={control} render={({ field }) => (
                <SearchableSelect
                  value={field.value ?? ''}
                  placeholder="— Select —"
                  onChange={field.onChange}
                  options={(categoriesQ.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
                />
              )} />
            </Field>
            <Field label="Variant Name" required error={errors.variantName?.message}>
              <Input placeholder="e.g. Pearl 4mm White" {...register('variantName')} />
            </Field>
            <Field label="Status">
              <Select {...register('status')}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </Select>
            </Field>
          </div>
        </div>

        <div>
          <SectionTitle><Ruler className="size-4" /> Variant Details</SectionTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Size" required error={errors.size?.message}><Input {...register('size')} /></Field>
            <Field label="Color" required error={errors.color?.message}><Input {...register('color')} /></Field>
            <Field label="Finish"><Input {...register('finish')} /></Field>
            <Field label="Shape"><Input {...register('shape')} /></Field>
            <Field label="Unit"><Input placeholder="pcs / gm / mm" {...register('unit')} /></Field>
            <Field label="Notes" className="col-span-2 sm:col-span-3"><Input {...register('notes')} /></Field>
          </div>
          <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Generated Material Code</div>
            <code className="mt-1 block text-sm font-semibold">{genCode || '— add supplier · material · size · colour —'}</code>
            <p className="mt-1 text-xs text-muted-foreground">Format: SupplierShort-Material-Size-Colour (auto from the preferred supplier).</p>
          </div>
        </div>

        <div>
          <SectionTitle><Users className="size-4" /> Raw Material Supplier(s) — at least one required</SectionTitle>
          <div className="space-y-2">
            {fields.map((f, idx) => (
              <div key={f.id} className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                  <div className="sm:col-span-3">
                    <Field label="Vendor" error={errors.vendors?.[idx]?.vendorId?.message}>
                      <Controller name={`vendors.${idx}.vendorId` as const} control={control} render={({ field }) => (
                        <SearchableSelect
                          value={field.value ?? ''}
                          placeholder="— Select vendor —"
                          onChange={(v) => field.onChange(v ? Number(v) : '')}
                          options={(vendorsQ.data ?? []).map((v) => ({ value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName }))}
                        />
                      )} />
                    </Field>
                  </div>
                  <div className="sm:col-span-3">
                    <Field label="Vendor Reference">
                      <Input placeholder="e.g. PRL-4W" {...register(`vendors.${idx}.vendorReference` as const)} />
                    </Field>
                  </div>
                  <div className="sm:col-span-2">
                    <Field label="Price (₹)">
                      <Input type="number" step="0.01" {...register(`vendors.${idx}.price` as const)} />
                    </Field>
                  </div>
                  <div className="sm:col-span-2">
                    <Field label="MOQ">
                      <Input type="number" step="0.01" {...register(`vendors.${idx}.moq` as const)} />
                    </Field>
                  </div>
                  <div className="flex items-end justify-between gap-2 sm:col-span-2">
                    <label className="flex items-center gap-1.5 pb-2 text-sm">
                      <input type="checkbox" className="accent-primary" {...register(`vendors.${idx}.isPreferred` as const)} />
                      Pref
                    </label>
                    <Button type="button" variant="outline" size="icon"
                      className="mb-0.5 text-destructive hover:bg-destructive/10"
                      onClick={() => remove(idx)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <Button
            type="button" variant="outline" size="sm" className="mt-2"
            onClick={() => append({ vendorId: 0 as any, vendorReference: '', notes: '', isPreferred: false } as any)}
          >
            <Plus className="size-4" /> Add Vendor
          </Button>
        </div>

        <div>
          <SectionTitle><ImageIcon className="size-4" /> Image</SectionTitle>
          <ImageUpload module="materials" value={imagePaths} onChange={setImagePaths} />
        </div>
      </form>
    </Dialog>
  );
}

function MaterialDatalist() {
  const { data } = useQuery({ queryKey: ['materials-list'], queryFn: () => Api.materials.list() });
  return (
    <datalist id="materialDatalist">
      {(data ?? []).map((m: any) => (
        <option key={m.id} value={m.materialName} />
      ))}
    </datalist>
  );
}
