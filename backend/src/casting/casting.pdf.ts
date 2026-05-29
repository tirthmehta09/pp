import PDFDocument from 'pdfkit';
import { Response } from 'express';

interface VendorPdfData {
  batchNumber: string;
  processName: string;
  docType?: string; // "Issue Slip" (default) or "Receipt"
  batchDate: Date;
  vendor: { vendorCode: string; vendorName: string };
  // Weight-priced steps (Casting/Plating/Antique) show Wt/pc + Total Wt columns;
  // piece-priced steps (Sticking/Meena/…) show Price + Total Amount instead.
  isWeightProcess?: boolean;
  // Internal docs (receipts) DO show our item number + colour + colour code.
  internal?: boolean;
  items: {
    // NOTE: our internal item number / sample design code is intentionally NEVER
    // included on a vendor (issue) slip. Vendors only ever see their own design ref.
    itemNumber?: string | null;
    colorCode?: string | null;
    vendorDesignReference: string | null;
    color?: string | null;
    weight: number;
    quantity: number;
    totalWeight: number;
    price?: number | null; // per-piece price from item master
    amount?: number | null; // price × qty
    remarks: string | null;
    materials?: { name: string; variantCode?: string | null; required: number; unit: string | null }[];
  }[];
}

/** Streams a casting-issue PDF containing only one vendor's items. */
export function streamVendorPdf(res: Response, data: VendorPdfData) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });

  const fileName = `casting-${data.batchNumber}-${data.vendor.vendorCode}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  doc.pipe(res);

  // Header
  doc.fontSize(18).fillColor('#1d4ed8').text(`${data.processName} ${data.docType ?? 'Issue Slip'}`, { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#111');
  doc.text(`Batch Number: ${data.batchNumber}`);
  doc.text(`Process: ${data.processName}`);
  doc.text(`Date: ${new Date(data.batchDate).toLocaleDateString('en-IN')}`);
  doc.text(`Vendor: ${data.vendor.vendorCode} - ${data.vendor.vendorName}`);
  doc.moveDown(0.6);

  // Weight slip (KG steps) vs amount slip (piece steps). Receipts are internal docs.
  const internal = !!data.internal;
  const weightMode = data.isWeightProcess !== false;
  const money = (n: number) => `Rs. ${n.toFixed(2)}`;

  const startX = 40;
  let y = doc.y;
  const cols = internal
    ? [
        { label: '#', width: 24 },
        { label: 'Item No', width: 60 },
        { label: 'Vendor Design Ref', width: 95 },
        { label: 'Colour', width: 70 },
        { label: 'Colour Code', width: 90 },
        { label: 'Qty', width: 45 },
        { label: 'Wt/pc', width: 60 },
        { label: 'Total Wt', width: 71 },
      ]
    : weightMode
      ? [
          { label: '#', width: 26 },
          { label: 'Vendor Design Ref', width: 150 },
          { label: 'Qty', width: 55 },
          { label: 'Wt/pc', width: 70 },
          { label: 'Total Wt', width: 80 },
          { label: 'Remarks', width: 134 },
        ]
      : [
          { label: '#', width: 26 },
          { label: 'Vendor Design Ref', width: 128 },
          { label: 'Colour', width: 70 },
          { label: 'Qty', width: 45 },
          { label: 'Price/pc', width: 72 },
          { label: 'Total Amount', width: 84 },
          { label: 'Remarks', width: 90 },
        ];
  const tableWidth = cols.reduce((s, c) => s + c.width, 0);

  const drawRow = (cells: string[], bold = false) => {
    let x = startX;
    doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#111');
    cells.forEach((c, i) => {
      doc.text(c, x + 2, y + 4, { width: cols[i].width - 4, ellipsis: true });
      x += cols[i].width;
    });
    const rowH = 18;
    doc.rect(startX, y, tableWidth, rowH).strokeColor('#ddd').stroke();
    y += rowH;
  };

  doc.fillColor('#111');
  drawRow(cols.map((c) => c.label), true);

  let totalQty = 0;
  let totalWeight = 0;
  let totalAmount = 0;
  data.items.forEach((it, idx) => {
    totalQty += it.quantity;
    totalWeight += it.totalWeight;
    totalAmount += it.amount ?? 0;
    if (y > 740) {
      doc.addPage();
      y = 40;
      drawRow(cols.map((c) => c.label), true);
    }
    const cells = internal
      ? [
          String(idx + 1),
          it.itemNumber ?? '—',
          it.vendorDesignReference ?? '—',
          it.color ?? '—',
          it.colorCode ?? '—',
          String(it.quantity),
          it.weight.toString(),
          it.totalWeight.toString(),
        ]
      : weightMode
        ? [
            String(idx + 1),
            it.vendorDesignReference ?? '—',
            String(it.quantity),
            it.weight.toString(),
            it.totalWeight.toString(),
            it.remarks ?? '',
          ]
        : [
            String(idx + 1),
            it.vendorDesignReference ?? '—',
            it.color ?? '—',
            String(it.quantity),
            it.price != null ? money(it.price) : '—',
            it.amount != null ? money(it.amount) : '—',
            it.remarks ?? '',
          ];
    drawRow(cells);
  });

  // Totals
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111');
  if (weightMode) {
    doc.text(`Total Quantity: ${totalQty}      Total Weight: ${totalWeight.toFixed(3)}`, startX, y + 8);
  } else {
    doc.text(`Total Quantity: ${totalQty}      Total Amount: ${money(totalAmount)}`, startX, y + 8);
  }
  y += 30;

  // ---- Colour bifurcation — only when multiple colours are on the slip. Quick
  // visual breakdown per colour so the vendor / floor sees what each colour totals.
  const coloursSeen = new Set(data.items.map((it) => (it.color ?? '').trim()).filter(Boolean));
  if (coloursSeen.size > 1) {
    y += 6;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1d4ed8').text('Colour Bifurcation', startX, y);
    y = doc.y + 4;
    doc.fillColor('#111');
    const cb = [
      { label: 'Colour', width: 140 },
      { label: 'Qty', width: 70 },
      ...(internal || !weightMode ? [{ label: weightMode ? 'Total Wt' : 'Total Amount', width: 110 }] : []),
      { label: 'Lines', width: 60 },
    ];
    const cbW = cb.reduce((s, c) => s + c.width, 0);
    const drawCb = (cells: string[], opts: { bold?: boolean; shade?: boolean } = {}) => {
      const rowH = 18;
      if (opts.shade) doc.rect(startX, y, cbW, rowH).fillColor('#eef2ff').fill();
      let x = startX;
      doc.fontSize(9).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#111');
      cells.forEach((c, i) => { doc.text(c, x + 2, y + 4, { width: cb[i].width - 4, ellipsis: true }); x += cb[i].width; });
      doc.rect(startX, y, cbW, rowH).strokeColor('#ddd').stroke();
      y += rowH;
    };
    drawCb(cb.map((c) => c.label), { bold: true, shade: true });
    const groups = new Map<string, { qty: number; total: number; lines: number }>();
    for (const it of data.items) {
      const c = (it.color ?? '').trim() || '—';
      const g = groups.get(c) ?? { qty: 0, total: 0, lines: 0 };
      g.qty += it.quantity;
      g.total += weightMode ? it.totalWeight : (it.amount ?? 0);
      g.lines += 1;
      groups.set(c, g);
    }
    for (const [colour, g] of groups) {
      const cells = [colour, String(g.qty)];
      if (internal || !weightMode) cells.push(weightMode ? g.total.toFixed(3) : money(g.total));
      cells.push(String(g.lines));
      drawCb(cells);
    }
    y += 8;
  }

  // ---- Bill of Materials (sticking slips) — the FULL list to stick, as a table.
  // ONE block per design on the slip (a sticking item always carries a materials
  // array — possibly empty). Each block names the item (the vendor's own design
  // ref) and the colour, so the floor knows exactly what goes on which design /
  // colour. An empty block flags that a BOM still needs to be configured.
  const withMaterials = data.items.filter((it) => Array.isArray(it.materials));
  if (withMaterials.length) {
    y += 12;
    if (y > 700) { doc.addPage(); y = 40; }
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#1d4ed8')
      .text('Bill of Materials — items to stick', startX, y);
    y = doc.y + 6;
    doc.fillColor('#111');

    const bomCols = [
      { label: 'Material', width: 250 },
      { label: 'Code', width: 110 },
      { label: 'Qty Required', width: 155 },
    ];
    const bomWidth = bomCols.reduce((s, c) => s + c.width, 0);

    const drawBomRow = (cells: string[], opts: { bold?: boolean; shade?: boolean } = {}) => {
      const rowH = 18;
      if (opts.shade) doc.rect(startX, y, bomWidth, rowH).fillColor('#eef2ff').fill();
      let x = startX;
      doc.fontSize(9).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#111');
      cells.forEach((c, i) => {
        doc.text(c, x + 2, y + 4, { width: bomCols[i].width - 4, ellipsis: true });
        x += bomCols[i].width;
      });
      doc.rect(startX, y, bomWidth, rowH).strokeColor('#ddd').stroke();
      y += rowH;
    };

    // Full-width banner naming the design + colour this BOM block is for.
    const drawGroupHeader = (text: string) => {
      const rowH = 20;
      doc.rect(startX, y, bomWidth, rowH).fillColor('#dbeafe').fill();
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor('#1e3a8a')
        .text(text, startX + 4, y + 5, { width: bomWidth - 8, ellipsis: true });
      doc.rect(startX, y, bomWidth, rowH).strokeColor('#bfdbfe').stroke();
      y += rowH;
      doc.fillColor('#111');
    };

    withMaterials.forEach((it, gi) => {
      if (y + 60 > 800) { doc.addPage(); y = 40; }
      const ref = it.vendorDesignReference ?? '—';
      const colour = it.color ? ` ·  Colour: ${it.color}` : '';
      drawGroupHeader(`Design ${gi + 1} of ${withMaterials.length} — ${ref}${colour}   (x${it.quantity} pcs)`);
      drawBomRow(bomCols.map((c) => c.label), { bold: true, shade: true });
      const mats = it.materials ?? [];
      if (!mats.length) {
        // Sticking design with no BOM yet — show a clear placeholder row.
        let x = startX;
        doc.fontSize(9).font('Helvetica-Oblique').fillColor('#b45309');
        doc.text('No materials configured for this colour — add a BOM in the item master.', x + 2, y + 4, { width: bomWidth - 4, ellipsis: true });
        doc.rect(startX, y, bomWidth, 18).strokeColor('#ddd').stroke();
        y += 18;
        doc.fillColor('#111');
      } else {
        mats.forEach((m) => {
          if (y + 18 > 800) { doc.addPage(); y = 40; drawBomRow(bomCols.map((c) => c.label), { bold: true, shade: true }); }
          drawBomRow([
            m.name,
            m.variantCode ?? '—',
            `${m.required}${m.unit ? ' ' + m.unit : ''}`,
          ]);
        });
      }
      y += 6;
    });
  }

  doc.end();
}
