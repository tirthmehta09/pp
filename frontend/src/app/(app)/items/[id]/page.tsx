'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Eye, Settings2, Star, Diamond, Info, Boxes } from 'lucide-react';
import { Api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { Spinner } from '@/components/ui/spinner';
import { fileUrl, formatCurrency } from '@/lib/utils';
import type { Item } from '@/lib/types';

const ATTR_LABELS: Record<string, string> = {
  weight: 'Weight Per Piece (g)', metal_type: 'Metal Type',
};

export default function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const itemId = Number(id);

  const { data: item, isLoading } = useQuery<Item>({
    queryKey: ['item', itemId],
    queryFn: () => Api.items.get(itemId),
  });

  if (isLoading || !item) {
    return <div className="flex items-center justify-center py-20"><Spinner className="size-6 text-primary" /></div>;
  }

  // Cost price is auto-calculated by the system (design + process costs, cost/kg aware).
  const totalCost = item.costPrice ?? 0;

  const basics: [string, string | null | undefined][] = [
    ['Item Number', item.itemNumber != null ? String(item.itemNumber) : null],
    ['Category', item.category], ['Subcategory', item.subcategory],
    ['Collection', item.collection], ['Design Type', item.designType],
    ['Designer', item.designerName],
    ['Design Cost', item.designCost != null ? formatCurrency(item.designCost) : null],
    ['Cost Price', item.costPrice != null ? formatCurrency(item.costPrice) : null],
    ['Selling Price', item.sellingPrice != null ? formatCurrency(item.sellingPrice) : null],
  ];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            {item.sampleDesignCode} <StatusBadge status={item.sampleStatus} />
          </h1>
          <p className="text-sm text-muted-foreground">
            {item.itemNumber != null ? `Item No. ${item.itemNumber}` : 'No item number'}
            {item.collection ? ` · ${item.collection}` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/items"><Button variant="outline"><ArrowLeft className="size-4" /> Back</Button></Link>
          <Link href={`/items/${itemId}/edit`}><Button><Pencil className="size-4" /> Edit</Button></Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              {item.images.length > 0 ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={fileUrl(item.images[0].filePath)} alt="" className="mb-2 max-h-72 w-full rounded-lg object-cover" />
                  <div className="flex flex-wrap gap-2">
                    {item.images.slice(1).map((im) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={im.id} src={fileUrl(im.filePath)} alt="" className="size-16 rounded-md border border-border object-cover" />
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center py-10 text-muted-foreground">
                  <Diamond className="size-8" /><span className="mt-2 text-sm">No images</span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <h2 className="mb-3 flex items-center gap-2 font-semibold"><Info className="size-4 text-primary" /> Basic Info</h2>
              {basics.map(([label, value]) => (
                <div key={label} className="flex justify-between border-b border-border py-1.5 text-sm last:border-0">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-medium">{value || '—'}</span>
                </div>
              ))}
              {item.cadFileUrl && (
                <a href={fileUrl(item.cadFilePath)} target="_blank" rel="noreferrer" className="mt-3 block">
                  <Button variant="outline" className="w-full"><Eye className="size-4" /> View CAD File</Button>
                </a>
              )}
              {item.notes && (
                <div className="mt-3">
                  <div className="mb-1 text-xs text-muted-foreground">Notes</div>
                  <p className="text-sm">{item.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column: blueprint */}
        <div className="lg:col-span-2">
          <Card>
            <CardContent className="p-5">
              <h2 className="mb-4 flex items-center gap-2 font-semibold"><Settings2 className="size-4 text-primary" /> Manufacturing Blueprint</h2>

              {item.processes.length === 0 ? (
                <p className="py-6 text-center text-muted-foreground">
                  No processes defined yet. <Link href={`/items/${itemId}/edit`} className="text-primary hover:underline">Add process details</Link>.
                </p>
              ) : (
                <div className="space-y-3">
                  {item.processes.map((p) => {
                    const isKg = p.costUnit === 'KG';
                    const usesColor = p.vendors.some((v) => v.color);
                    return (
                    <div key={p.processId} className="rounded-lg border border-border p-4">
                      <h3 className="mb-2 flex items-center gap-2 font-semibold text-primary">
                        <Settings2 className="size-4" /> {p.name}
                        {isKg && <Badge variant="info">per KG</Badge>}
                      </h3>
                      {Object.keys(p.attributes).length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                          {Object.entries(p.attributes).map(([k, v]) => (
                            <span key={k}>
                              <span className="text-muted-foreground">{ATTR_LABELS[k] ?? k}: </span>
                              <span className="font-medium">{v}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      {!!(p.services && p.services.length) && (
                        <div className="mb-2 text-sm">
                          <span className="text-muted-foreground">Services: </span>
                          {p.services.map((s, i) => (
                            <span key={s.serviceId} className="font-medium">
                              {i > 0 ? ', ' : ''}{s.name}{s.cost != null ? ` (${formatCurrency(s.cost)})` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                      {p.vendors.length > 0 ? (
                        <div className="overflow-x-auto">
                          <table className="w-full table-fixed text-sm" style={{ minWidth: 640 }}>
                            <colgroup>
                              <col style={{ width: usesColor ? '24%' : '30%' }} />
                              {usesColor && <col style={{ width: '14%' }} />}
                              <col style={{ width: '20%' }} />
                              <col style={{ width: '16%' }} />
                              <col style={{ width: '8%' }} />
                              <col style={{ width: usesColor ? '18%' : '26%' }} />
                            </colgroup>
                            <thead className="text-left text-muted-foreground">
                              <tr>
                                <th className="py-1 pr-3">Vendor</th>
                                {usesColor && <th className="py-1 pr-3">Colour</th>}
                                <th className="py-1 pr-3">Vendor Design Ref.</th>
                                <th className="py-1 pr-3">{isKg ? 'Cost / KG' : 'Cost / Pc'}</th>
                                <th className="py-1 pr-3">Pref.</th>
                                <th className="py-1">Notes</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.vendors.map((v, i) => (
                                <tr key={i} className="border-t border-border align-top">
                                  <td className="truncate py-1.5 pr-3">{v.vendorCode} · {v.vendorName}</td>
                                  {usesColor && <td className="truncate py-1.5 pr-3">{v.color || '—'}</td>}
                                  <td className="truncate py-1.5 pr-3">{v.vendorDesignReference || '—'}</td>
                                  <td className="py-1.5 pr-3">{formatCurrency(v.costPerPiece)}</td>
                                  <td className="py-1.5 pr-3">{v.isPreferred ? <Star className="size-4 fill-amber-400 text-amber-400" /> : '—'}</td>
                                  <td className="truncate py-1.5 text-muted-foreground">{v.notes || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">No vendors assigned yet.</p>
                      )}
                      {!!(p.photos && p.photos.length) && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {p.photos!.map((ph) => (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img key={ph.id} src={fileUrl(ph.filePath)} alt="" className="size-12 rounded border border-border object-cover" />
                          ))}
                        </div>
                      )}
                      {p.notes && <p className="mt-2 text-sm text-muted-foreground">Note: {p.notes}</p>}
                    </div>
                    );
                  })}
                </div>
              )}

              {/* Bill of Materials — preferred sticking colour only */}
              {(() => {
                const stick = item.processes.find((p) => p.code === 'STICKING');
                const sv = stick?.vendors ?? [];
                const prefColour = ((sv.find((v) => v.isPreferred) ?? sv[0])?.color ?? '').trim();
                const rows = (item.materials ?? []).filter(
                  (m) => ((m.stickingColor ?? '').trim().toLowerCase()) === prefColour.toLowerCase(),
                );
                if (!rows.length) return null;
                return (
                  <div className="mt-4 rounded-lg border border-border p-4">
                    <h3 className="mb-2 flex items-center gap-2 font-semibold text-primary">
                      <Boxes className="size-4" /> Bill of Materials
                      {prefColour && <Badge variant="outline">{prefColour}</Badge>}
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-left text-muted-foreground">
                          <tr>
                            <th className="py-1 pr-3">Material</th>
                            <th className="py-1 pr-3">Qty/pc</th>
                            <th className="py-1 pr-3">Price/pc</th>
                            <th className="py-1 pr-3">Line Cost</th>
                            <th className="py-1">In Stock</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((m, i) => (
                            <tr key={i} className="border-t border-border">
                              <td className="py-1.5 pr-3">
                                <span className="font-medium">{m.variantName}</span>
                                {(m.size || m.color) && <span className="text-muted-foreground"> · {[m.size, m.color].filter(Boolean).join(' · ')}</span>}
                              </td>
                              <td className="py-1.5 pr-3">{m.quantity} pcs</td>
                              <td className="py-1.5 pr-3">{formatCurrency(m.price)}</td>
                              <td className="py-1.5 pr-3">{formatCurrency(m.lineCost)}</td>
                              <td className="py-1.5">{m.stockQty}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              <div className="mt-4 flex items-center justify-between rounded-lg border border-border bg-muted/30 px-4 py-3">
                <span className="font-medium">Auto cost price (design + process + material costs)</span>
                <span className="font-bold text-primary">{formatCurrency(totalCost)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
