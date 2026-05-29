import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { nextCode } from '../common/code-generator';
import { KG_PROCESSES, COLOUR_PROCESSES } from '../processes/processes.service';
import { MaterialIssuesService } from '../material-issues/material-issues.service';
import {
  BatchQueryDto,
  CastingBatchItemDto,
  CreateBatchDto,
  CreateReceiptDto,
  ForwardStageDto,
  UpdateStageDto,
  ReceiptQueryDto,
} from './dto/casting.dto';

@Injectable()
export class CastingService {
  constructor(
    private prisma: PrismaService,
    private materialIssues: MaterialIssuesService,
  ) {}

  /**
   * Resolve a batch-item row. When `itemId` is supplied, the vendor (preferred),
   * vendor design reference, per-piece weight, cost/kg and services are auto-fetched
   * from the item's process data; explicit fields override. Only Production-Ready
   * items may enter a batch. Totals are computed (KG processes use weight × cost/kg).
   */
  private async resolveRow(processId: number, processCode: string, row: CastingBatchItemDto) {
    let {
      itemId, quantity, vendorId, itemNumber, itemName,
      vendorDesignReference, weight, totalWeight, costPerKg, remarks,
    } = row;
    let services: string | null = null;

    if (itemId) {
      const item = await this.prisma.item.findUnique({
        where: { id: itemId },
        include: {
          processes: {
            include: { process: true, vendors: true, attributes: true, services: { include: { service: true } } },
          },
        },
      });
      if (!item) throw new NotFoundException('Item not found.');
      if (item.sampleStatus !== 'PRODUCTION_READY') {
        throw new BadRequestException(
          `${item.sampleDesignCode} is not Production Ready and cannot enter a batch.`,
        );
      }
      // Use the numeric Item Number; never expose the internal sample design code here.
      itemNumber = itemNumber ?? (item.itemNumber != null ? String(item.itemNumber) : '');
      itemName = itemName ?? item.itemName ?? undefined;

      // Per-piece weight comes from the Casting process (grams).
      const casting = item.processes.find((p) => p.process.code === 'CASTING');
      const weightAttr = casting?.attributes.find((a) => a.attrKey === 'weight')?.attrValue;
      if (weight == null) weight = weightAttr ? Number(weightAttr) : 0;

      // Vendor/cost from the entry of the batch's own process. If a vendor was
      // explicitly chosen, use that vendor's entry; otherwise the preferred/first.
      const proc = item.processes.find((p) => p.processId === processId);
      const entries = proc?.vendors ?? [];
      const chosen =
        (vendorId ? entries.find((e) => e.vendorId === vendorId) : undefined) ??
        entries.find((e) => e.isPreferred) ??
        entries[0];
      if (chosen) {
        vendorId = vendorId ?? chosen.vendorId;
        vendorDesignReference = vendorDesignReference ?? (chosen.vendorDesignReference ?? undefined);
        if (costPerKg == null && chosen.costPerPiece != null) costPerKg = Number(chosen.costPerPiece);
      }
      if (proc?.services?.length) services = proc.services.map((s) => s.service.name).join(', ');
    }

    if (!vendorId) {
      throw new BadRequestException('Vendor is required (no preferred vendor found for this item/process).');
    }

    const w = Number(weight ?? 0);
    // Total weight is editable; fall back to weight × quantity when not supplied.
    const finalTotalWeight =
      totalWeight != null && !Number.isNaN(Number(totalWeight)) ? Number(totalWeight) : w * quantity;
    const isKg = KG_PROCESSES.includes(processCode);
    const totalCost =
      costPerKg != null
        ? isKg
          ? (finalTotalWeight / 1000) * Number(costPerKg)
          : Number(costPerKg) * quantity
        : null;

    return {
      itemId: itemId ?? null,
      itemNumber: itemNumber ?? '',
      itemName: itemName ?? null,
      vendorId,
      vendorDesignReference: vendorDesignReference ?? null,
      weight: w,
      quantity,
      totalWeight: finalTotalWeight,
      costPerKg: costPerKg ?? null,
      totalCost,
      services,
      remarks: remarks ?? null,
    };
  }

  // ---------------- Batches (Casting Issue) ----------------
  /** Peek the next batch number (shown in the create form) without creating. */
  async nextBatchNumber() {
    return {
      batchNumber: await nextCode(this.prisma, 'castingBatch', 'batchNumber', 'B', 4),
    };
  }

  /**
   * Create a production batch. Production ALWAYS starts at Casting: each design
   * line becomes a Casting stage (lineKey = its own id). From there, received
   * pieces are forwarded to any next process, in any order (see forwardStage).
   */
  async createBatch(dto: CreateBatchDto, userId?: number) {
    const casting = await this.prisma.process.findFirst({ where: { code: 'CASTING' } });
    if (!casting) throw new NotFoundException('Casting process is not configured.');

    const batchNumber =
      dto.batchNumber?.trim() ||
      (await nextCode(this.prisma, 'castingBatch', 'batchNumber', 'B', 4));

    const batch = await this.prisma.castingBatch.create({
      data: {
        batchNumber,
        processId: casting.id, // starting process
        batchDate: new Date(dto.batchDate),
        notes: dto.notes ?? null,
        createdById: userId ?? null,
      },
    });

    let order = 0;
    for (const row of dto.items) {
      const data = await this.resolveRow(casting.id, casting.code, row);
      const created = await this.prisma.castingBatchItem.create({
        data: {
          batchId: batch.id,
          ...data,
          processId: casting.id,
          colorModel: row.colorModel ?? null,
          color: row.color ?? null,
          sortOrder: order++,
        },
      });
      // lineKey groups all future stages of this design line.
      await this.prisma.castingBatchItem.update({
        where: { id: created.id },
        data: { lineKey: String(created.id) },
      });
      await this.assignIssueSlip(created.id);
    }
    await this.recomputeBatchStatus(batch.id);
    return { id: batch.id, batchNumber: batch.batchNumber };
  }

  /**
   * Group a freshly-created stage onto an issue slip. Stages issued to the same
   * batch + process + vendor within 15 minutes share one slip (so a piece added
   * within the window joins the same slip); after 15 minutes a new slip starts.
   */
  private async assignIssueSlip(stageId: number) {
    const stage = await this.prisma.castingBatchItem.findUnique({ where: { id: stageId } });
    if (!stage) return;
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const sibling = await this.prisma.castingBatchItem.findFirst({
      where: {
        batchId: stage.batchId,
        processId: stage.processId,
        vendorId: stage.vendorId,
        id: { not: stage.id },
        issueSlipAt: { gte: cutoff },
      },
      orderBy: { issueSlipAt: 'desc' },
    });
    await this.prisma.castingBatchItem.update({
      where: { id: stage.id },
      data: {
        issueSlipId: sibling?.issueSlipId ?? stage.id,
        issueSlipAt: sibling?.issueSlipAt ?? new Date(),
      },
    });
  }

  /**
   * Forward received pieces of a stage to the next process (any order, partial).
   * Creates a child stage (same lineKey) with the target process's preferred
   * vendor/cost auto-fetched. Sticking stages consume BOM stock for their qty.
   *
   * `opts.targetBatchId` (optional, internal): when supplied, the new child
   * stage lives in a DIFFERENT batch — used by the new-batch flow to absorb
   * settled pieces from old (often short-closed) batches into the fresh batch.
   * The parentItemId still points back to the source for ancestry, but the
   * child gets a brand-new lineKey rooted in itself so it appears as a new
   * line in the target batch.
   */
  async forwardStage(
    batchItemId: number,
    dto: ForwardStageDto,
    userId?: number,
    opts: { targetBatchId?: number } = {},
  ) {
    const source = await this.prisma.castingBatchItem.findUnique({
      where: { id: batchItemId },
      include: { receiptRows: true, stageProcess: true },
    });
    if (!source) throw new NotFoundException('Stage not found.');
    if (source.stageProcess?.code === 'PACKING') {
      throw new BadRequestException('Packing is the final step — these pieces are finished and cannot be forwarded further.');
    }

    const received = source.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
    const children = await this.prisma.castingBatchItem.findMany({ where: { parentItemId: source.id } });
    const forwarded = children.reduce((s, c) => s + c.quantity, 0);
    const available = received - forwarded;
    if (dto.quantity <= 0) throw new BadRequestException('Quantity must be greater than zero.');
    if (dto.quantity > available) {
      throw new BadRequestException(`Only ${available} received piece(s) are available to forward.`);
    }

    const target = await this.prisma.process.findUnique({ where: { id: dto.processId } });
    if (!target) throw new NotFoundException('Next process not found.');

    // Auto-pick the vendor whose colour matches the colour CHOSEN for this next
    // step (when no vendor was explicitly chosen). The colour is selected per
    // step, so the vendor must be matched on dto.color — the colour for the
    // target process — never the source stage's colour.
    let vendorId = dto.vendorId;
    let vendorDesignReference = dto.vendorDesignReference;
    let costPerKg = dto.costPerKg;
    const matchColor = dto.color ?? null;
    if (!vendorId && source.itemId && matchColor) {
      const item = await this.prisma.item.findUnique({
        where: { id: source.itemId },
        include: { processes: { include: { vendors: true } } },
      });
      const proc = item?.processes.find((p) => p.processId === dto.processId);
      const match = proc?.vendors.find(
        (v) => (v.color ?? '').trim().toLowerCase() === matchColor.trim().toLowerCase(),
      );
      if (match) {
        vendorId = match.vendorId;
        if (vendorDesignReference == null) vendorDesignReference = match.vendorDesignReference ?? undefined;
        if (costPerKg == null && match.costPerPiece != null) costPerKg = Number(match.costPerPiece);
      }
    }

    const data = await this.resolveRow(target.id, target.code, {
      itemId: source.itemId ?? undefined,
      quantity: dto.quantity,
      vendorId,
      weight: dto.weight,
      totalWeight: dto.totalWeight,
      costPerKg,
      vendorDesignReference,
      remarks: dto.remarks,
    });

    // When absorbing into a different batch (e.g. settling old stock into a new
    // batch), the child gets a fresh lineKey rooted in itself — within the new
    // batch it's a new line. parentItemId still points to the source for trace.
    const destBatchId = opts.targetBatchId ?? source.batchId;
    const crossBatch = destBatchId !== source.batchId;
    const lineKey = crossBatch ? null : (source.lineKey ?? String(source.id));
    const maxOrder = await this.prisma.castingBatchItem.aggregate({
      where: { batchId: destBatchId, ...(lineKey ? { lineKey } : {}) },
      _max: { sortOrder: true },
    });

    const created = await this.prisma.castingBatchItem.create({
      data: {
        batchId: destBatchId,
        ...data,
        processId: target.id,
        parentItemId: source.id,
        // Will be backfilled to created.id when crossing batches (below).
        lineKey: lineKey ?? '',
        colorModel: source.colorModel ?? null,
        // Colour is chosen per step — never carried to a non-colour step.
        color: dto.color ?? null,
        sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
      },
    });
    if (crossBatch) {
      await this.prisma.castingBatchItem.update({
        where: { id: created.id },
        data: { lineKey: String(created.id) },
      });
    }

    if (target.code === 'STICKING' && source.itemId) {
      // Freeze the BOM onto the stage so its slip is immune to later item-master edits.
      await this.snapshotStageBom(created.id, source.itemId, dto.quantity, dto.color ?? created.color);
      if (!dto.bringsOwnMaterials) {
        // Auto-create a material-issue voucher to the sticking vendor based on BOM,
        // optionally with a buffer (we typically send more than strictly needed).
        // When `materialIssueOverride` is supplied (user edited the qty at issue time),
        // those numbers take precedence over the BOM × buffer computation.
        await this.autoIssueStickingMaterials(
          created.id, source.itemId, dto.quantity, dto.color ?? created.color,
          (vendorId ?? created.vendorId), source.batchId,
          dto.materialBufferPercent ?? 0,
          dto.materialIssueOverride, userId,
        );
      }
    }
    await this.assignIssueSlip(created.id);
    await this.recomputeBatchStatus(source.batchId);
    if (crossBatch) await this.recomputeBatchStatus(destBatchId);
    return { id: created.id };
  }

  /** Edit a stage's vendor / qty / weight / rate / colour / remarks (history preserved). */
  async updateStage(id: number, dto: UpdateStageDto) {
    const stage = await this.prisma.castingBatchItem.findUnique({
      where: { id },
      include: { stageProcess: true },
    });
    if (!stage) throw new NotFoundException('Stage not found.');
    const code = stage.stageProcess?.code ?? 'CASTING';
    const isKg = KG_PROCESSES.includes(code);
    const isForwardedStage = stage.parentItemId != null;

    // Quantity of a forwarded (downstream) step is governed by the Send amount,
    // never hand-edited — editing it would break piece-conservation with its parent.
    // Only the root Casting issue qty is directly editable (with the forwarded guard).
    if (dto.quantity != null && !isForwardedStage) {
      const children = await this.prisma.castingBatchItem.findMany({ where: { parentItemId: stage.id } });
      const forwarded = children.reduce((s, c) => s + c.quantity, 0);
      if (dto.quantity < forwarded) {
        throw new BadRequestException(`Cannot set quantity to ${dto.quantity} — ${forwarded} piece(s) were already forwarded to the next process.`);
      }
    }

    const quantity = isForwardedStage ? stage.quantity : (dto.quantity ?? stage.quantity);
    const weight = dto.weight ?? Number(stage.weight);
    const totalWeight = dto.totalWeight ?? Math.round(weight * quantity * 1000) / 1000;
    const costPerKg = dto.costPerKg ?? (stage.costPerKg != null ? Number(stage.costPerKg) : null);
    const totalCost =
      costPerKg != null ? (isKg ? (totalWeight / 1000) * costPerKg : costPerKg * quantity) : null;

    await this.prisma.castingBatchItem.update({
      where: { id },
      data: {
        vendorId: dto.vendorId ?? stage.vendorId,
        vendorDesignReference: dto.vendorDesignReference ?? stage.vendorDesignReference,
        quantity,
        weight,
        totalWeight,
        costPerKg,
        totalCost: totalCost != null ? Math.round(totalCost * 100) / 100 : null,
        color: dto.color ?? stage.color,
        remarks: dto.remarks ?? stage.remarks,
      },
    });
    await this.recomputeBatchStatus(stage.batchId);
    return { id };
  }

  /**
   * Public preview of the sticking BOM × qty × (1 + buffer%) — used by the
   * Forward dialog to show the user the editable default issue qty per material
   * variant BEFORE the forward fires. Returns a flat list aggregated across
   * multiple colours (when forwarding several colour-lots in one go) plus the
   * default issue qty (which may then be overridden via materialIssueOverride).
   */
  async previewStickingIssue(
    itemId: number,
    splits: { color?: string | null; quantity: number }[],
    bufferPercent = 0,
  ) {
    if (!splits?.length) return { lines: [] };
    const agg = new Map<number, any>();
    for (const s of splits) {
      if (!s.quantity || s.quantity <= 0) continue;
      const bom = await this.buildStickingBom(itemId, s.quantity, s.color ?? null);
      for (const b of bom) {
        const cur = agg.get(b.variantId) ?? {
          variantId: b.variantId,
          variantCode: b.variantCode,
          variantName: b.variantName,
          unit: b.unit,
          required: 0,
        };
        cur.required += Number(b.required);
        agg.set(b.variantId, cur);
      }
    }
    // Pull current stock for context (so the dialog can flag shortages).
    const variantIds = Array.from(agg.keys());
    const variants = variantIds.length
      ? await this.prisma.materialVariant.findMany({ where: { id: { in: variantIds } } })
      : [];
    const stockById = new Map(variants.map((v) => [v.id, Number(v.stockQty)]));
    const lines = Array.from(agg.values()).map((r) => {
      const required = Math.round(r.required * 1000) / 1000;
      const defaultIssue = Math.max(0, Math.ceil(required * (1 + (bufferPercent || 0) / 100)));
      return {
        variantId: r.variantId,
        variantCode: r.variantCode,
        variantName: r.variantName,
        unit: r.unit,
        required,
        defaultIssue,
        stockQty: stockById.get(r.variantId) ?? 0,
      };
    });
    return { lines };
  }

  /**
   * Build the sticking BOM (stage colour + colourless common lines) for an item.
   * Both perPiece and required are forced to WHOLE NUMBERS — you can't issue
   * 0.95 of a stone. Any historical decimal BOM rows get rounded up here too.
   */
  private async buildStickingBom(itemId: number, stageQty: number, stageColor?: string | null) {
    const all = await this.prisma.itemMaterial.findMany({ where: { itemId }, include: { variant: true } });
    const sc = (stageColor ?? '').trim().toLowerCase();
    const bom = all.filter((l) => !l.color || (sc && l.color.trim().toLowerCase() === sc));
    return bom.map((line) => {
      const perPiece = Math.max(1, Math.round(Number(line.quantity)));
      return {
        variantId: line.variantId,
        variantCode: line.variant.variantCode,
        variantName: line.variant.variantName,
        unit: line.variant.unit ?? null,
        perPiece,
        required: perPiece * stageQty,
      };
    });
  }

  /** Persist an immutable BOM snapshot onto a sticking stage at issue time. */
  private async snapshotStageBom(stageId: number, itemId: number, stageQty: number, stageColor?: string | null) {
    const snapshot = await this.buildStickingBom(itemId, stageQty, stageColor);
    await this.prisma.castingBatchItem.update({ where: { id: stageId }, data: { bomSnapshot: snapshot } });
  }

  /**
   * Auto-create a material-issue voucher when forwarding to Sticking — replaces
   * the old "silent stock consumption" with a real, trackable vendor movement.
   * Qty per line = ceil(BOM × stageQty × (1 + buffer%)), always a whole number.
   * If `override` is supplied (user explicitly typed qty per variant at issue time),
   * those numbers WIN — we still merge with any BOM-derived variant that wasn't
   * overridden so the user can omit a line and keep the BOM default for the rest.
   */
  private async autoIssueStickingMaterials(
    stageId: number, itemId: number, stageQty: number, stageColor: string | null | undefined,
    vendorId: number, batchId: number,
    bufferPercent: number,
    override?: { variantId: number; issuedQty: number }[],
    userId?: number,
  ) {
    const bom = await this.buildStickingBom(itemId, stageQty, stageColor);
    const overrideMap = new Map<number, number>();
    for (const o of override ?? []) {
      const q = Math.max(0, Math.trunc(Number(o.issuedQty) || 0));
      overrideMap.set(o.variantId, q);
    }
    const lines = bom
      .map((b) => ({
        variantId: b.variantId,
        issuedQty: overrideMap.has(b.variantId)
          ? overrideMap.get(b.variantId)!
          : Math.max(0, Math.ceil(Number(b.required) * (1 + (bufferPercent || 0) / 100))),
      }))
      .filter((l) => l.issuedQty > 0);
    // Allow user-added variants that aren't in the item's BOM at all (rare, but
    // supports "I want to also send these extra studs not in BOM").
    const bomVariantIds = new Set(bom.map((b) => b.variantId));
    for (const [variantId, issuedQty] of overrideMap) {
      if (!bomVariantIds.has(variantId) && issuedQty > 0) {
        lines.push({ variantId, issuedQty });
      }
    }
    if (!lines.length) return null;
    // STOCK GUARD — verify every line has enough raw-material stock BEFORE
    // creating the issue. Otherwise we'd silently drive stock negative, hiding
    // the shortage from the user. Failing here surfaces the problem at issue
    // time so they can order more or reduce the qty.
    const variants = await this.prisma.materialVariant.findMany({
      where: { id: { in: lines.map((l) => l.variantId) } },
    });
    const stockById = new Map(variants.map((v) => [v.id, Math.round(Number(v.stockQty))]));
    const shortages: { variantId: number; variantCode: string; variantName: string; need: number; have: number; short: number }[] = [];
    for (const l of lines) {
      const have = stockById.get(l.variantId) ?? 0;
      if (l.issuedQty > have) {
        const v = variants.find((x) => x.id === l.variantId);
        shortages.push({
          variantId: l.variantId,
          variantCode: v?.variantCode ?? `#${l.variantId}`,
          variantName: v?.variantName ?? '',
          need: l.issuedQty,
          have,
          short: l.issuedQty - have,
        });
      }
    }
    if (shortages.length) {
      // BadRequestException with structured details — the frontend reads the
      // body to surface "Order more" links per shortage.
      const err: any = new BadRequestException({
        message: 'RAW_MATERIAL_SHORTAGE',
        shortages,
        humanMessage: `Cannot issue — not enough raw material in stock for ${shortages.length} item(s).`,
      });
      throw err;
    }
    return this.materialIssues.create(
      { vendorId, batchId, stageId, lines, notes: `Auto-issued for sticking stage ${stageId}` },
      userId,
    );
  }

  /** Consume BOM stock for one Sticking stage — WHOLE NUMBERS only. */
  private async consumeStageStickingMaterials(stageId: number, itemId: number, stageQty: number, stageColor?: string | null, userId?: number) {
    const all = await this.prisma.itemMaterial.findMany({ where: { itemId } });
    const sc = (stageColor ?? '').trim().toLowerCase();
    const bom = all.filter((l) => !l.color || (sc && l.color.trim().toLowerCase() === sc));
    for (const line of bom) {
      const qty = Math.round(Number(line.quantity)) * stageQty;
      if (qty <= 0) continue;
      const v = await this.prisma.materialVariant.findUnique({ where: { id: line.variantId } });
      if (!v) continue;
      const balanceAfter = Math.max(0, Math.round(Number(v.stockQty)) - qty);
      await this.prisma.$transaction([
        this.prisma.materialVariant.update({ where: { id: line.variantId }, data: { stockQty: balanceAfter } }),
        this.prisma.stockMovement.create({
          data: {
            variantId: line.variantId, type: 'OUT', quantity: -qty, balanceAfter,
            refType: 'sticking_stage', refId: stageId,
            note: `Sticking stage ${stageId} consumption`, createdById: userId ?? null,
          },
        }),
      ]);
    }
  }

  /** Reverse a single stage's sticking consumption (used when a batch is deleted). */
  private async reverseStageSticking(stageId: number) {
    const moves = await this.prisma.stockMovement.findMany({ where: { refType: 'sticking_stage', refId: stageId } });
    for (const mv of moves) {
      const v = await this.prisma.materialVariant.findUnique({ where: { id: mv.variantId } });
      if (!v) continue;
      const balanceAfter = Math.round((Number(v.stockQty) - Number(mv.quantity)) * 1000) / 1000;
      await this.prisma.materialVariant.update({ where: { id: mv.variantId }, data: { stockQty: balanceAfter } });
    }
    await this.prisma.stockMovement.deleteMany({ where: { refType: 'sticking_stage', refId: stageId } });
  }

  /**
   * Consume material-variant stock for a Sticking batch: for each item line,
   * required = Σ (BOM qty × batch qty × (1 + wastage%)). Records OUT movements
   * referencing the batch; stock may go negative (shortage) and is flagged elsewhere.
   */
  private async consumeStickingMaterials(batchId: number, processCode: string, userId?: number) {
    if (processCode !== 'STICKING') return;
    const items = await this.prisma.castingBatchItem.findMany({
      where: { batchId, itemId: { not: null } },
    });
    const need = new Map<number, number>(); // variantId -> total qty
    for (const bi of items) {
      const bom = await this.prisma.itemMaterial.findMany({ where: { itemId: bi.itemId! } });
      for (const line of bom) {
        const qty = Number(line.quantity) * bi.quantity;
        if (qty > 0) need.set(line.variantId, (need.get(line.variantId) ?? 0) + qty);
      }
    }
    for (const [variantId, qtyRaw] of need) {
      const qty = Math.round(qtyRaw);
      const v = await this.prisma.materialVariant.findUnique({ where: { id: variantId } });
      if (!v) continue;
      const balanceAfter = Math.max(0, Math.round(Number(v.stockQty)) - qty);
      await this.prisma.$transaction([
        this.prisma.materialVariant.update({ where: { id: variantId }, data: { stockQty: balanceAfter } }),
        this.prisma.stockMovement.create({
          data: {
            variantId, type: 'OUT', quantity: -qty, balanceAfter,
            refType: 'sticking_batch', refId: batchId,
            note: `Sticking batch ${batchId} consumption`, createdById: userId ?? null,
          },
        }),
      ]);
    }
  }

  /** Reverse a batch's sticking consumption (on edit/delete). */
  private async reverseStickingMaterials(batchId: number) {
    const moves = await this.prisma.stockMovement.findMany({
      where: { refType: 'sticking_batch', refId: batchId },
    });
    for (const mv of moves) {
      const v = await this.prisma.materialVariant.findUnique({ where: { id: mv.variantId } });
      if (!v) continue;
      // mv.quantity is negative (OUT); subtracting it adds the stock back.
      const balanceAfter = Math.round((Number(v.stockQty) - Number(mv.quantity)) * 1000) / 1000;
      await this.prisma.materialVariant.update({ where: { id: mv.variantId }, data: { stockQty: balanceAfter } });
    }
    await this.prisma.stockMovement.deleteMany({ where: { refType: 'sticking_batch', refId: batchId } });
  }

  /**
   * Edit a batch. Items are reconciled by id: existing ids are updated,
   * missing ids are deleted (cascading their receipts), new rows created.
   */
  async updateBatch(id: number, dto: CreateBatchDto) {
    const batch = await this.prisma.castingBatch.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!batch) throw new NotFoundException('Batch not found.');

    const processId = dto.processId ?? batch.processId;
    const process = processId ? await this.prisma.process.findUnique({ where: { id: processId } }) : null;
    const processCode = process?.code ?? 'CASTING';

    await this.prisma.castingBatch.update({
      where: { id },
      data: { processId: processId ?? undefined, batchDate: new Date(dto.batchDate), notes: dto.notes ?? null },
    });

    const keepIds = dto.items.filter((i) => i.id).map((i) => i.id!) as number[];
    await this.prisma.castingBatchItem.deleteMany({
      where: { batchId: id, id: { notIn: keepIds.length ? keepIds : [0] } },
    });

    for (const it of dto.items) {
      const data = await this.resolveRow(processId!, processCode, it);
      if (it.id) {
        await this.prisma.castingBatchItem.update({ where: { id: it.id }, data });
      } else {
        await this.prisma.castingBatchItem.create({ data: { batchId: id, ...data } });
      }
    }

    // Re-sync sticking consumption to the new item set.
    await this.reverseStickingMaterials(id);
    await this.consumeStickingMaterials(id, processCode);
    await this.recomputeBatchStatus(id);
    return { id, batchNumber: batch.batchNumber };
  }

  async listBatches(query: BatchQueryDto) {
    const where: Prisma.CastingBatchWhereInput = {};
    if (query.status) where.status = query.status as any;
    if (query.search) {
      where.OR = [
        { batchNumber: { contains: query.search } },
        { items: { some: { vendor: { vendorName: { contains: query.search } } } } },
      ];
    }
    const batches = await this.prisma.castingBatch.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        items: { include: { vendor: true, receiptRows: true, stageProcess: true } },
      },
    });

    return batches.map((b) => {
      const vendors = Array.from(
        new Map(b.items.map((i) => [i.vendorId, i.vendor.vendorName])).entries(),
      ).map(([id, name]) => ({ id, name }));

      // Traveler metrics: design lines + pieces ordered into production (root casting
      // stages only), and how many stages are still awaiting receipt.
      const lineKeys = new Set(b.items.map((i) => i.lineKey ?? String(i.id)));
      const rootStages = b.items.filter((i) => i.parentItemId == null);
      const piecesOrdered = rootStages.reduce((s, i) => s + i.quantity, 0);
      let openStages = 0;
      for (const it of b.items) {
        if (it.closed) continue;
        const recd = it.receiptRows.reduce((rs, r) => rs + r.receivedQty, 0);
        if (it.quantity - recd > 0) openStages++;
      }
      // Distinct processes reached so far in this batch (in display order).
      const processNames = Array.from(
        new Map(b.items.filter((i) => i.stageProcess).map((i) => [i.stageProcess!.sortOrder, i.stageProcess!.name])).entries(),
      ).sort((a, c) => a[0] - c[0]).map(([, n]) => n);

      // Lifecycle: Completed when every line has a fully-received Packing stage.
      const anyReceived = b.items.some((i) => i.receiptRows.reduce((rs, r) => rs + r.receivedQty, 0) > 0);
      const linePacked = new Map<string, boolean>();
      for (const k of lineKeys) linePacked.set(k, false);
      for (const it of b.items) {
        if (it.stageProcess?.code === 'PACKING') {
          const recd = it.receiptRows.reduce((rs, r) => rs + r.receivedQty, 0);
          if (it.quantity > 0 && recd >= it.quantity) linePacked.set(it.lineKey ?? String(it.id), true);
        }
      }
      const allComplete = lineKeys.size > 0 && Array.from(linePacked.values()).every(Boolean);
      const displayStatus = allComplete ? 'Completed' : anyReceived ? 'In Process' : 'Issued';

      // Has any stage been short-closed? Used to surface the batch under "Short-Closed".
      const hasShorts = b.items.some((it) => it.closed && (it.shortQty ?? 0) > 0);
      // Item numbers in this batch (for design-number search in Batch Inventory).
      const designNumbers = Array.from(
        new Set(
          b.items
            .map((it) => it.itemNumber)
            .filter((n): n is string => !!n && n !== ''),
        ),
      );
      return {
        id: b.id,
        batchNumber: b.batchNumber,
        batchDate: b.batchDate,
        status: b.status,
        displayStatus,
        notes: b.notes,
        // Batch-level short-close — drives the Batch Inventory "Short-Closed" folder.
        closed: b.closed,
        closedAt: b.closedAt,
        closedReason: b.closedReason,
        designCount: lineKeys.size,
        piecesOrdered,
        openStages,
        stageCount: b.items.length,
        processNames,
        vendors,
        hasShorts,
        designNumbers,
      };
    });
  }

  async getBatch(id: number) {
    const batch = await this.prisma.castingBatch.findUnique({
      where: { id },
      include: {
        process: true,
        items: { include: { vendor: true, stageProcess: true }, orderBy: [{ lineKey: 'asc' }, { sortOrder: 'asc' }] },
        receipts: {
          include: { vendor: true, items: { include: { batchItem: { include: { stageProcess: true } } } } },
          orderBy: { receiptDate: 'asc' },
        },
      },
    });
    if (!batch) throw new NotFoundException('Batch not found.');

    // received totals per batch item
    const receivedByItem = new Map<number, { qty: number; weight: number }>();
    for (const r of batch.receipts) {
      for (const ri of r.items) {
        const cur = receivedByItem.get(ri.batchItemId) ?? { qty: 0, weight: 0 };
        cur.qty += ri.receivedQty;
        cur.weight += Number(ri.receivedWeight);
        receivedByItem.set(ri.batchItemId, cur);
      }
    }

    // Forwarded-out totals per stage (sum of child stages' qty) — counted ACROSS
    // batches because settled pieces can land in a different (new) batch.
    const stageIds = batch.items.map((i) => i.id);
    const externalChildren = stageIds.length
      ? await this.prisma.castingBatchItem.findMany({
          where: { parentItemId: { in: stageIds } },
          select: { parentItemId: true, quantity: true },
        })
      : [];
    const forwardedByParent = new Map<number, number>();
    for (const c of externalChildren) {
      if (c.parentItemId != null) {
        forwardedByParent.set(c.parentItemId, (forwardedByParent.get(c.parentItemId) ?? 0) + c.quantity);
      }
    }

    // Colour-model counts for the designs used in this batch.
    const itemIds = Array.from(new Set(batch.items.map((i) => i.itemId).filter((x): x is number => x != null)));
    const cmCounts = new Map<number, number>();
    if (itemIds.length) {
      const grouped = await this.prisma.itemColorModel.groupBy({ by: ['itemId'], where: { itemId: { in: itemIds } }, _count: { _all: true } });
      for (const g of grouped) cmCounts.set(g.itemId, g._count._all);
    }

    const items = batch.items.map((it) => {
      const rec = receivedByItem.get(it.id) ?? { qty: 0, weight: 0 };
      const pendingQty = it.quantity - rec.qty;
      const forwardedQty = forwardedByParent.get(it.id) ?? 0;
      return {
        id: it.id,
        itemId: it.itemId,
        itemNumber: it.itemNumber,
        itemName: it.itemName,
        processId: it.processId,
        processName: it.stageProcess?.name ?? batch.process?.name ?? '—',
        processCode: it.stageProcess?.code ?? null,
        parentItemId: it.parentItemId,
        lineKey: it.lineKey ?? String(it.id),
        issueSlipId: it.issueSlipId ?? it.id,
        colorModel: it.colorModel,
        color: it.color,
        colorModelsAvailable: it.itemId ? (cmCounts.get(it.itemId) ?? 0) : 0,
        vendorId: it.vendorId,
        vendorName: it.vendor.vendorName,
        vendorCode: it.vendor.vendorCode,
        vendorDesignReference: it.vendorDesignReference,
        weight: Number(it.weight),
        quantity: it.quantity,
        totalWeight: Number(it.totalWeight),
        costPerKg: it.costPerKg != null ? Number(it.costPerKg) : null,
        totalCost: it.totalCost != null ? Number(it.totalCost) : null,
        remarks: it.remarks,
        receivedQty: rec.qty,
        receivedWeight: rec.weight,
        pendingQty,
        pendingWeight: Number(it.totalWeight) - rec.weight,
        excessShortQty: rec.qty - it.quantity, // +excess / -short
        forwardedQty,
        // Packing is the final step — its pieces are finished, never forwarded onward.
        availableToForward: it.stageProcess?.code === 'PACKING' ? 0 : Math.max(rec.qty - forwardedQty, 0),
        closed: it.closed,
        closedReason: it.closedReason,
        shortQty: it.shortQty,
        shortWeight: it.shortWeight != null ? Number(it.shortWeight) : null,
        done: it.closed || pendingQty <= 0,
        // Per-stage lifecycle status.
        status: it.closed ? 'Closed' : rec.qty >= it.quantity ? 'Completed' : rec.qty > 0 ? 'Partial' : 'Pending',
      };
    });

    // Group stages into design lines (by lineKey) for the traveler view.
    const lineMap = new Map<string, any>();
    for (const it of items) {
      const key = it.lineKey;
      const line = lineMap.get(key) ?? {
        lineKey: key,
        itemId: it.itemId,
        itemNumber: it.itemNumber,
        itemName: it.itemName,
        colorModel: it.colorModel,
        colorModelsAvailable: it.colorModelsAvailable,
        stages: [] as any[],
      };
      line.stages.push(it);
      lineMap.set(key, line);
    }
    const lines = Array.from(lineMap.values());

    // Mark each line's completion + the batch lifecycle status.
    for (const line of lines) {
      const packed = line.stages.find((s: any) => s.processCode === 'PACKING' && s.receivedQty >= s.quantity && s.quantity > 0);
      line.completed = !!packed;
    }
    const anyReceived = items.some((it) => it.receivedQty > 0);
    const allLinesComplete = lines.length > 0 && lines.every((l: any) => l.completed);
    const displayStatus = allLinesComplete ? 'Completed' : anyReceived ? 'In Process' : 'Issued';

    // vendor grouping (for PDFs) + per-vendor completion (for the receive flow)
    const vendors = Array.from(
      new Map(batch.items.map((i) => [i.vendorId, i.vendor])).values(),
    ).map((v) => {
      const vendorItems = items.filter((it) => it.vendorId === v.id);
      const completed = vendorItems.length > 0 && vendorItems.every((it) => it.done);
      return { id: v.id, vendorCode: v.vendorCode, vendorName: v.vendorName, completed };
    });

    // Sticking batches: aggregate BOM material requirement vs current stock,
    // both overall (for inventory check) and grouped by vendor + design
    // (so the floor knows which materials go to whom for sticking).
    let materialRequirement: any[] = [];
    let materialByVendor: any[] = [];
    const stickingStages = batch.items.filter((bi) => bi.stageProcess?.code === 'STICKING');
    if (stickingStages.length) {
      const reqMap = new Map<number, any>();
      const vendorMap = new Map<number, any>();
      for (const bi of stickingStages) {
        if (!bi.itemId) continue;
        const allBom = await this.prisma.itemMaterial.findMany({
          where: { itemId: bi.itemId },
          include: { variant: true },
        });
        // Only this stage colour's BOM (+ colour-less common lines).
        const sc = (bi.color ?? '').trim().toLowerCase();
        const bom = allBom.filter((l) => !l.color || (sc && l.color.trim().toLowerCase() === sc));
        if (!bom.length) continue;

        // Per-vendor grouping
        const vg =
          vendorMap.get(bi.vendorId) ??
          {
            vendorId: bi.vendorId,
            vendorCode: bi.vendor.vendorCode,
            vendorName: bi.vendor.vendorName,
            items: [] as any[],
          };
        const itemMaterials = bom.map((line) => ({
          variantId: line.variantId,
          variantCode: line.variant.variantCode,
          variantName: line.variant.variantName,
          unit: line.variant.unit,
          perPiece: Number(line.quantity),
          required:
            Math.round(
              Number(line.quantity) * bi.quantity * 1000,
            ) / 1000,
        }));
        vg.items.push({
          batchItemId: bi.id,
          itemNumber: bi.itemNumber,
          vendorDesignReference: bi.vendorDesignReference,
          itemName: bi.itemName,
          color: bi.color,
          quantity: bi.quantity,
          materials: itemMaterials,
        });
        vendorMap.set(bi.vendorId, vg);

        // Overall stock requirement with per-design breakdown — so "Inventory
        // Consumption" can show how the 1000 stones split across designs.
        const designKey = bi.itemNumber || '—';
        for (const line of bom) {
          const need = Number(line.quantity) * bi.quantity;
          const cur = reqMap.get(line.variantId) ?? {
            variantId: line.variantId,
            variantCode: line.variant.variantCode,
            variantName: line.variant.variantName,
            unit: line.variant.unit,
            required: 0,
            stockQty: Number(line.variant.stockQty),
            byDesignMap: new Map<string, number>(),
          };
          cur.required += need;
          cur.byDesignMap.set(designKey, (cur.byDesignMap.get(designKey) ?? 0) + need);
          reqMap.set(line.variantId, cur);
        }
      }
      materialRequirement = Array.from(reqMap.values()).map((r) => ({
        variantId: r.variantId,
        variantCode: r.variantCode,
        variantName: r.variantName,
        unit: r.unit,
        required: Math.round(r.required * 1000) / 1000,
        stockQty: r.stockQty,
        short: r.required > r.stockQty,
        byDesign: Array.from(r.byDesignMap.entries()).map(([itemNumber, qty]: any) => ({
          itemNumber, qty: Math.round((qty as number) * 1000) / 1000,
        })),
      }));
      materialByVendor = Array.from(vendorMap.values());
    }

    return {
      id: batch.id,
      batchNumber: batch.batchNumber,
      processId: batch.processId,
      processName: batch.process?.name ?? '—',
      batchDate: batch.batchDate,
      notes: batch.notes,
      status: batch.status,
      displayStatus,
      closed: batch.closed,
      closedAt: batch.closedAt,
      closedReason: batch.closedReason,
      vendors,
      materialRequirement,
      materialByVendor,
      items,
      lines,
      summary: this.buildBatchSummary(items),
      receipts: batch.receipts.map((r) => ({
        id: r.id,
        receiptNumber: r.receiptNumber,
        receiptDate: r.receiptDate,
        vendorId: r.vendorId,
        vendorName: r.vendor.vendorName,
        vendorCode: r.vendor.vendorCode,
        processName: r.items[0]?.batchItem.stageProcess?.name ?? '—',
        processCode: r.items[0]?.batchItem.stageProcess?.code ?? null,
        qty: r.items.reduce((s, ri) => s + ri.receivedQty, 0),
        weight: Math.round(r.items.reduce((s, ri) => s + Number(ri.receivedWeight), 0) * 1000) / 1000,
        itemCount: r.items.length,
      })),
    };
  }

  /** Live batch verification totals across all stages (qty + weight). */
  private buildBatchSummary(items: any[]) {
    const r = (n: number) => Math.round(n * 1000) / 1000;
    let issuedQty = 0, receivedQty = 0, pendingQty = 0, excessQty = 0, shortQty = 0;
    let issuedWeight = 0, receivedWeight = 0;
    for (const it of items) {
      issuedQty += it.quantity;
      receivedQty += it.receivedQty;
      issuedWeight += it.totalWeight;
      receivedWeight += it.receivedWeight;
      if (it.closed) shortQty += it.shortQty ?? 0;
      else pendingQty += Math.max(it.quantity - it.receivedQty, 0);
      excessQty += Math.max(it.receivedQty - it.quantity, 0);
    }
    return {
      issuedQty, receivedQty, pendingQty, excessQty, shortQty,
      issuedWeight: r(issuedWeight), receivedWeight: r(receivedWeight),
      balanceWeight: r(issuedWeight - receivedWeight),
    };
  }

  async removeBatch(id: number) {
    // Return any consumed sticking material to stock before deleting.
    await this.reverseStickingMaterials(id); // legacy batch-level
    const stages = await this.prisma.castingBatchItem.findMany({ where: { batchId: id }, select: { id: true } });
    for (const s of stages) await this.reverseStageSticking(s.id);
    await this.prisma.castingBatch.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Batch not found.');
    });
    return { id };
  }

  /** Distinct vendors in a batch — used to render per-vendor PDF buttons. */
  async batchVendors(id: number) {
    const items = await this.prisma.castingBatchItem.findMany({
      where: { batchId: id },
      include: { vendor: true },
    });
    return Array.from(new Map(items.map((i) => [i.vendorId, i.vendor])).values()).map(
      (v) => ({ id: v.id, vendorCode: v.vendorCode, vendorName: v.vendorName }),
    );
  }

  // ---------------- Receipts (Casting Receipt) ----------------
  async createReceipt(dto: CreateReceiptDto, userId?: number) {
    const batch = await this.prisma.castingBatch.findUnique({ where: { id: dto.batchId } });
    if (!batch) throw new NotFoundException('Batch not found.');

    const receiptNumber = await nextCode(
      this.prisma,
      'castingReceipt',
      'receiptNumber',
      'R',
      5,
    );

    // Per-piece weight per batch item (for proportional weight auto-calc).
    // Closed lines cannot receive any more.
    const batchItems = await this.prisma.castingBatchItem.findMany({
      where: { batchId: dto.batchId, vendorId: dto.vendorId, closed: false },
      select: { id: true, weight: true },
    });
    const weightById = new Map(batchItems.map((b) => [b.id, Number(b.weight)]));
    const validIds = new Set(batchItems.map((b) => b.id));

    const rows = dto.items.filter(
      (i) => validIds.has(i.batchItemId) && ((i.receivedQty ?? 0) !== 0 || (i.receivedWeight ?? 0) !== 0),
    );

    const receipt = await this.prisma.castingReceipt.create({
      data: {
        batchId: dto.batchId,
        vendorId: dto.vendorId,
        receiptNumber,
        receiptDate: new Date(dto.receiptDate),
        notes: dto.notes ?? null,
        createdById: userId ?? null,
        items: {
          create: rows.map((i) => {
            const qty = i.receivedQty ?? 0;
            // Auto-calc received weight from qty × per-piece weight when not supplied.
            const weight =
              i.receivedWeight != null && i.receivedWeight !== 0
                ? i.receivedWeight
                : qty * (weightById.get(i.batchItemId) ?? 0);
            return {
              batchItemId: i.batchItemId,
              receivedQty: qty,
              receivedWeight: weight,
              remarks: i.remarks ?? null,
            };
          }),
        },
      },
    });

    await this.recomputeBatchStatus(dto.batchId);

    // Auto-forward: any stage in this receipt with a `plannedNextProcessId`
    // gets its newly-received pieces forwarded straight to the planned step,
    // landing in `plannedTargetBatchId` (the new production batch). This is
    // what makes the "at-vendor pieces flow into the new batch on receipt"
    // experience work end-to-end — the user planned it once in the New Batch
    // dialog and never has to remember to forward at receive time.
    for (const rec of rows) {
      const stage = await this.prisma.castingBatchItem.findUnique({
        where: { id: rec.batchItemId },
        select: {
          id: true,
          plannedNextProcessId: true,
          plannedNextVendorId: true,
          plannedNextColor: true,
          plannedTargetBatchId: true,
        },
      });
      if (!stage?.plannedNextProcessId) continue;
      const qty = rec.receivedQty ?? 0;
      if (qty <= 0) continue;
      try {
        await this.forwardStage(
          stage.id,
          {
            processId: stage.plannedNextProcessId,
            quantity: qty,
            vendorId: stage.plannedNextVendorId ?? undefined,
            color: stage.plannedNextColor ?? undefined,
          },
          userId,
          { targetBatchId: stage.plannedTargetBatchId ?? undefined },
        );
      } catch {
        // If the auto-forward fails (e.g., target batch deleted, planned
        // vendor inactive), surface it in remarks but don't reject the
        // receipt — the user can forward manually.
        await this.prisma.castingBatchItem.update({
          where: { id: stage.id },
          data: { remarks: 'Planned auto-forward failed — forward manually.' },
        });
      }
    }
    return { id: receipt.id, receiptNumber };
  }

  /**
   * Delete a receipt (correction handling) and restore all balances. Blocked if
   * any of its received pieces have already been forwarded to a next process —
   * those must be reversed first so quantities stay consistent.
   */
  async deleteReceipt(receiptId: number) {
    const receipt = await this.prisma.castingReceipt.findUnique({
      where: { id: receiptId },
      include: { items: true },
    });
    if (!receipt) throw new NotFoundException('Receipt not found.');

    for (const ri of receipt.items) {
      const bi = await this.prisma.castingBatchItem.findUnique({
        where: { id: ri.batchItemId },
        include: { receiptRows: true },
      });
      if (!bi) continue;
      const currentReceived = bi.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
      const children = await this.prisma.castingBatchItem.findMany({ where: { parentItemId: bi.id } });
      const forwarded = children.reduce((s, c) => s + c.quantity, 0);
      if (currentReceived - ri.receivedQty < forwarded) {
        throw new BadRequestException(
          `Cannot delete this receipt — ${forwarded} piece(s) of "${bi.vendorDesignReference ?? bi.itemNumber}" were already forwarded to the next process. Reverse that first.`,
        );
      }
    }

    const batchId = receipt.batchId;
    // Snapshot for UNDO — lets the client recreate this exact receipt.
    const undo = {
      batchId,
      vendorId: receipt.vendorId,
      receiptDate: receipt.receiptDate,
      notes: receipt.notes ?? undefined,
      items: receipt.items.map((ri) => ({
        batchItemId: ri.batchItemId,
        receivedQty: ri.receivedQty,
        receivedWeight: Number(ri.receivedWeight),
        remarks: ri.remarks ?? undefined,
      })),
    };
    await this.prisma.castingReceipt.delete({ where: { id: receiptId } });
    await this.recomputeBatchStatus(batchId);
    return { id: receiptId, undo };
  }

  async listReceipts(query: ReceiptQueryDto) {
    const where: Prisma.CastingReceiptWhereInput = {};
    if (query.search) {
      where.OR = [
        { receiptNumber: { contains: query.search } },
        { batch: { batchNumber: { contains: query.search } } },
        { vendor: { vendorName: { contains: query.search } } },
      ];
    }
    const receipts = await this.prisma.castingReceipt.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { batch: true, vendor: true, _count: { select: { items: true } } },
    });
    return receipts.map((r) => ({
      id: r.id,
      receiptNumber: r.receiptNumber,
      receiptDate: r.receiptDate,
      batchId: r.batchId,
      batchNumber: r.batch.batchNumber,
      // Delivery status of the parent batch:
      // COMPLETED -> Completely Delivered, PARTIAL -> Partial, OPEN -> Not Delivered.
      batchStatus: r.batch.status,
      vendorId: r.vendorId,
      vendorName: r.vendor.vendorName,
      itemCount: r._count.items,
    }));
  }

  /**
   * Pending sheet for a batch + vendor (used by the receive form). Only shows
   * stages that still have pieces to receive — closed lines and fully-received
   * (already forwarded) stages are excluded so the floor only sees open work.
   *
   * For STICKING stages we also surface the linked material-issue voucher's
   * open lines so the receive form can prompt "vendor returning the extra
   * material or keeping it?" inline, instead of forcing a separate trip to
   * the Material Issues page.
   */
  async pendingForVendor(batchId: number, vendorId: number) {
    const batch = await this.getBatch(batchId);
    const items = batch.items.filter((i) => i.vendorId === vendorId && !i.closed && i.pendingQty > 0);

    // For sticking stages, attach the linked material-issue (if any).
    const stickingItems = items.filter((i) => i.processCode === 'STICKING');
    let linkedIssuesByStage = new Map<number, any>();
    if (stickingItems.length) {
      const issues = await this.prisma.materialIssue.findMany({
        where: {
          stageId: { in: stickingItems.map((i) => i.id) },
          status: { not: 'CLOSED' },
        },
        include: { lines: { include: { variant: true } }, stage: true },
      });
      for (const iss of issues) {
        if (!iss.stageId) continue;
        // Pull perPiece from the stage's BOM snapshot so the receive form can
        // auto-calculate "used = perPiece × sticking pcs received NOW". This
        // is the same number the system used at issue time, frozen.
        const snap: any[] = Array.isArray(iss.stage?.bomSnapshot) ? (iss.stage!.bomSnapshot as any[]) : [];
        const perPieceByVariant = new Map<number, number>();
        for (const s of snap) {
          if (!s?.variantId) continue;
          const pp = s.perPiece != null ? Number(s.perPiece) : 0;
          perPieceByVariant.set(s.variantId, Math.round(pp));
        }
        const lines = iss.lines
          .map((l) => {
            const cons = (l as any).consumedQty ?? 0;
            // Pending here excludes already-consumed — that's what the vendor
            // physically still has and can return/keep/mark-used at this receipt.
            const pending = l.issuedQty - l.receivedQty - cons;
            return {
              lineId: l.id,
              variantId: l.variantId,
              variantCode: l.variant.variantCode,
              variantName: l.variant.variantName,
              unit: l.variant.unit,
              issuedQty: l.issuedQty,
              receivedQty: l.receivedQty,
              consumedQty: cons,
              pendingQty: pending,
              // BOM per sticking piece — drives the auto-used calc in the UI.
              perPiece: perPieceByVariant.get(l.variantId) ?? 0,
            };
          })
          .filter((l) => l.pendingQty > 0);
        if (lines.length) {
          linkedIssuesByStage.set(iss.stageId, {
            issueId: iss.id,
            voucherNumber: iss.voucherNumber,
            lines,
          });
        }
      }
    }

    return {
      batchNumber: batch.batchNumber,
      items: items.map((i) => ({
        ...i,
        // Only populated for sticking stages that have an open auto-issued voucher.
        materialIssue: linkedIssuesByStage.get(i.id) ?? null,
      })),
    };
  }

  /**
   * Full-fledged inventory: every piece of every design wherever it is, in one of
   * three states — FINISHED (packed, in our hands), IN_HOUSE (received mid-chain,
   * awaiting next forward), AT_VENDOR (issued, vendor is working on it). Grouped
   * by design + process + vendor + COLOUR so colour lots don't merge.
   */
  async producedGoods(itemId?: number) {
    // Load ALL stages (incl. closed) so the forwarded-out chain stays correct —
    // a parent's child stage still counts toward its forwarded total even if the
    // child was later short-closed. We only filter closed stages when EMITTING.
    const rows = await this.prisma.castingBatchItem.findMany({
      where: itemId ? { itemId } : {},
      include: {
        receiptRows: true,
        stageProcess: true,
        item: { include: { processes: { include: { process: true, vendors: true } } } },
        batch: true,
        vendor: true,
      },
    });
    // Forwarded-out qty per stage = Σ children quantity (across ALL children).
    const fwd = new Map<number, number>();
    for (const r of rows) if (r.parentItemId != null) fwd.set(r.parentItemId, (fwd.get(r.parentItemId) ?? 0) + r.quantity);

    const nextProcessOf = (r: (typeof rows)[number]) => {
      const procs = (r.item?.processes ?? [])
        .filter((p) => (p.vendors?.length ?? 0) > 0)
        .sort((a, b) => a.process.sortOrder - b.process.sortOrder);
      const curSort = r.stageProcess?.sortOrder ?? null;
      if (curSort == null) return null;
      const next = procs.find((p) => p.process.sortOrder > curSort);
      if (!next) return null;
      const colours = Array.from(new Set(next.vendors.map((v) => (v.color ?? '').trim()).filter(Boolean)));
      return {
        nextProcessId: next.processId,
        nextProcessName: next.process.name,
        nextProcessCode: next.process.code,
        nextUsesColor: COLOUR_PROCESSES.includes(next.process.code),
        nextColorOptions: colours,
      };
    };

    const baseInfo = (r: (typeof rows)[number]) => ({
      itemId: r.itemId!,
      itemNumber: r.item?.itemNumber ?? null,
      designCode: r.item?.sampleDesignCode ?? r.itemNumber,
      itemName: r.item?.itemName ?? null,
      processId: r.processId,
      processName: r.stageProcess?.name ?? '—',
      processCode: r.stageProcess?.code ?? null,
      vendorId: r.vendorId,
      vendorCode: r.vendor?.vendorCode ?? null,
      vendorName: r.vendor?.vendorName ?? null,
      color: r.color ?? null,
      // Reflects whether the parent batch was short-closed — the inventory page
      // marks these lots as "frozen / short-closed" instead of "ready for next step".
      batchClosed: r.batch?.closed === true,
    });

    // Group key INCLUDES colour so colour lots stay separate (no more merging).
    const groups = new Map<string, any>();
    for (const r of rows) {
      if (!r.itemId) continue;
      const received = r.receiptRows.reduce((s, x) => s + x.receivedQty, 0);
      const idle = received - (fwd.get(r.id) ?? 0);
      // Closed (short-closed) stages: the UNRECEIVED portion was written off to the
      // vendor ledger as an outstanding balance, so at-vendor = 0. But the pieces
      // that DID come back are real stock and must still appear in inventory.
      const atVendor = r.closed ? 0 : r.quantity - received;
      const colourKey = (r.color ?? '').toLowerCase();
      // Include batch-closed status in the key so a closed-batch lot stays distinct
      // from an active-batch lot of the same design/process/vendor/colour.
      const batchClosedKey = r.batch?.closed ? 'C' : 'O';
      const baseKey = `${r.itemId}:${r.processId}:${r.vendorId}:${colourKey}:${batchClosedKey}`;

      if (idle > 0) {
        const isFinished = r.stageProcess?.code === 'PACKING';
        const state = isFinished ? 'FINISHED' : 'IN_HOUSE';
        const key = `${state}:${baseKey}`;
        const np = !isFinished ? nextProcessOf(r) : null;
        const g = groups.get(key) ?? {
          state, finished: isFinished, // legacy flag for existing UI
          ...baseInfo(r),
          qty: 0,
          stages: [] as { id: number; idle: number }[],
          batches: new Set<string>(),
          ...(np ?? { nextProcessId: null, nextProcessName: null, nextProcessCode: null, nextUsesColor: false, nextColorOptions: [] as string[] }),
        };
        g.qty += idle;
        g.stages.push({ id: r.id, idle });
        g.batches.add(r.batch.batchNumber);
        groups.set(key, g);
      }

      if (atVendor > 0) {
        const key = `AT_VENDOR:${baseKey}`;
        // For AT_VENDOR we surface the suggested next process too, so the
        // new-batch dialog can default the planned forward target.
        const np = nextProcessOf(r);
        const g = groups.get(key) ?? {
          state: 'AT_VENDOR', finished: false,
          ...baseInfo(r),
          qty: 0,
          // Stage ids ARE needed for AT_VENDOR — the new-batch dialog uses them
          // to register a "planned forward" so receipts auto-route into the
          // new batch (see /casting/stages/:id/plan-forward). batchId +
          // perPieceWeight let the dialog construct a Receive Goods call when
          // the user picks "Receive now" instead of "plan for later".
          stages: [] as { id: number; idle: number; batchId: number; perPieceWeight: number }[],
          batches: new Set<string>(),
          ...(np ?? { nextProcessId: null, nextProcessName: null, nextProcessCode: null, nextUsesColor: false, nextColorOptions: [] as string[] }),
        };
        g.qty += atVendor;
        g.stages.push({ id: r.id, idle: atVendor, batchId: r.batchId, perPieceWeight: Number(r.weight) });
        g.batches.add(r.batch.batchNumber);
        groups.set(key, g);
      }
    }

    const allRows = Array.from(groups.values())
      .map((g) => ({ ...g, batches: Array.from(g.batches) }))
      .sort((a, b) => String(a.itemNumber ?? '').localeCompare(String(b.itemNumber ?? ''), undefined, { numeric: true }));

    // Per-design rollup so the inventory page can show totals per design.
    const byDesignMap = new Map<number, any>();
    for (const g of allRows) {
      const cur = byDesignMap.get(g.itemId) ?? {
        itemId: g.itemId, itemNumber: g.itemNumber, designCode: g.designCode, itemName: g.itemName,
        finishedQty: 0, inHouseQty: 0, atVendorQty: 0, totalQty: 0,
      };
      if (g.state === 'FINISHED') cur.finishedQty += g.qty;
      else if (g.state === 'IN_HOUSE') cur.inHouseQty += g.qty;
      else cur.atVendorQty += g.qty;
      cur.totalQty += g.qty;
      byDesignMap.set(g.itemId, cur);
    }
    const byDesign = Array.from(byDesignMap.values()).sort((a, b) => String(a.itemNumber ?? '').localeCompare(String(b.itemNumber ?? ''), undefined, { numeric: true }));

    return { rows: allRows, byDesign };
  }

  /**
   * Record a "planned forward" on an AT-VENDOR stage. When this stage is later
   * received via Receive Goods, the receipt handler will auto-forward the newly
   * received pieces to the planned next process / vendor / colour, into the
   * planned target batch. Lets the new-batch dialog steer at-vendor pieces into
   * the new batch the moment they physically return — no manual forward needed.
   *
   * Pass nulls to clear an existing plan.
   */
  async planForward(
    stageId: number,
    plan: {
      nextProcessId: number | null;
      vendorId?: number | null;
      color?: string | null;
      targetBatchId?: number | null;
    },
  ) {
    const stage = await this.prisma.castingBatchItem.findUnique({ where: { id: stageId } });
    if (!stage) throw new NotFoundException('Stage not found.');
    await this.prisma.castingBatchItem.update({
      where: { id: stageId },
      data: {
        plannedNextProcessId: plan.nextProcessId ?? null,
        plannedNextVendorId: plan.vendorId ?? null,
        plannedNextColor: plan.color ?? null,
        plannedTargetBatchId: plan.targetBatchId ?? null,
      },
    });
    return { id: stageId };
  }

  /**
   * "Continue" idle in-process pieces straight to their next process — used from
   * the new-batch dialog so existing stock is settled instead of re-cast. Forwards
   * each idle stage's available pieces to `nextProcessId` (colour chosen per step,
   * which auto-picks that colour's vendor unless `vendorId` overrides).
   *
   * `maxQty` caps the TOTAL forwarded across all listed stages — so the dialog
   * can say "use 30 of these 80 idle pcs and leave the rest in stock." When
   * omitted, every stage's full idle qty is forwarded as before.
   */
  async settleInProcess(
    dto: { stageIds: number[]; nextProcessId: number; color?: string; vendorId?: number; maxQty?: number; targetBatchId?: number },
    userId?: number,
  ) {
    if (!dto.stageIds?.length) throw new BadRequestException('No pieces to continue.');
    let forwarded = 0;
    let remaining = dto.maxQty != null ? Math.max(0, Math.trunc(dto.maxQty)) : Number.POSITIVE_INFINITY;
    for (const stageId of dto.stageIds) {
      if (remaining <= 0) break;
      const stage = await this.prisma.castingBatchItem.findUnique({
        where: { id: stageId },
        include: { receiptRows: true },
      });
      if (!stage) continue;
      const received = stage.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
      const children = await this.prisma.castingBatchItem.findMany({ where: { parentItemId: stage.id } });
      const already = children.reduce((s, c) => s + c.quantity, 0);
      const idle = received - already;
      if (idle <= 0) continue;
      const take = Math.min(idle, remaining);
      await this.forwardStage(
        stageId,
        { processId: dto.nextProcessId, quantity: take, color: dto.color, vendorId: dto.vendorId },
        userId,
        { targetBatchId: dto.targetBatchId },
      );
      forwarded += take;
      remaining -= take;
    }
    if (forwarded === 0) throw new BadRequestException('Nothing available to continue.');
    return { forwarded };
  }

  private async recomputeBatchStatus(batchId: number) {
    const items = await this.prisma.castingBatchItem.findMany({
      where: { batchId },
      include: { receiptRows: true },
    });
    let anyReceived = false;
    let allDone = true;
    for (const it of items) {
      const recQty = it.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
      if (recQty > 0) anyReceived = true;
      // A line is "done" when fully received OR short-closed.
      if (!it.closed && recQty < it.quantity) allDone = false;
    }
    const status = allDone && items.length > 0 ? 'COMPLETED' : anyReceived ? 'PARTIAL' : 'OPEN';
    await this.prisma.castingBatch.update({ where: { id: batchId }, data: { status } });
  }

  /** Short-close ONE order line: settle it even though received < ordered. */
  async closeBatchItem(id: number, reason?: string) {
    const item = await this.prisma.castingBatchItem.findUnique({
      where: { id },
      include: { receiptRows: true },
    });
    if (!item) throw new NotFoundException('Batch item not found.');
    const receivedQty = item.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
    const receivedWeight = item.receiptRows.reduce((s, r) => s + Number(r.receivedWeight), 0);
    const shortQty = Math.max(item.quantity - receivedQty, 0);
    const shortWeight = Math.max(Number(item.totalWeight) - receivedWeight, 0);
    await this.prisma.castingBatchItem.update({
      where: { id },
      data: {
        closed: true,
        closedReason: reason ?? null,
        closedAt: new Date(),
        shortQty,
        shortWeight,
      },
    });
    await this.recomputeBatchStatus(item.batchId);
    return { id, shortQty, shortWeight };
  }

  /**
   * Mark a batch as Short-Closed at the batch level — also short-closes every
   * still-open stage along the way. The batch.closed flag is the source of truth
   * for the Batch Inventory "Short-Closed" folder; per-stage shorts alone do not
   * qualify a batch as closed.
   */
  async closeBatch(batchId: number, reason?: string) {
    const batch = await this.prisma.castingBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Batch not found.');
    const stages = await this.prisma.castingBatchItem.findMany({
      where: { batchId, closed: false },
      include: { receiptRows: true },
    });
    let closedStages = 0;
    for (const s of stages) {
      const received = s.receiptRows.reduce((a, r) => a + r.receivedQty, 0);
      if (received >= s.quantity) continue; // already fully received → nothing to short
      await this.closeBatchItem(s.id, reason);
      closedStages++;
    }
    await this.prisma.castingBatch.update({
      where: { id: batchId },
      data: { closed: true, closedAt: new Date(), closedReason: reason ?? null },
    });
    return { closedStages };
  }

  /** Reopen a batch marked Short-Closed. (Per-stage closes can be reopened separately.) */
  async reopenBatch(batchId: number) {
    const batch = await this.prisma.castingBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Batch not found.');
    await this.prisma.castingBatch.update({
      where: { id: batchId },
      data: { closed: false, closedAt: null, closedReason: null },
    });
    await this.recomputeBatchStatus(batchId);
    return { id: batchId };
  }

  /** Re-open a mistakenly short-closed line. */
  async reopenBatchItem(id: number) {
    const item = await this.prisma.castingBatchItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Batch item not found.');
    await this.prisma.castingBatchItem.update({
      where: { id },
      data: { closed: false, closedReason: null, closedAt: null, shortQty: null, shortWeight: null },
    });
    await this.recomputeBatchStatus(item.batchId);
    return { id };
  }

  /**
   * Vendor ledger (Balances & Bills): issues + receipts in a date range, plus
   * the running outstanding balance from short-closed lines (qty, weight, amount).
   */
  async vendorLedger(vendorId: number, from?: string, to?: string) {
    const fromD = from ? new Date(from) : new Date('1970-01-01');
    const toD = to ? new Date(`${to}T23:59:59`) : new Date('2999-12-31');

    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Vendor not found.');

    // Issues in range (by batch date). We include `stageProcess` so the ledger
    // shows what this VENDOR actually did (Sticking/Plating/etc.) — NOT the
    // batch's initial process (Casting) which was the old, wrong behaviour.
    const lines = await this.prisma.castingBatchItem.findMany({
      where: { vendorId, batch: { batchDate: { gte: fromD, lte: toD } } },
      include: { batch: true, stageProcess: true, receiptRows: true },
      orderBy: [{ batch: { batchDate: 'asc' } }, { id: 'asc' }],
    });

    const issues = lines.map((it) => {
      const recQty = it.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
      return {
        date: it.batch.batchDate,
        batchNumber: it.batch.batchNumber,
        // Process this VENDOR did (Sticking/Plating/Meena…), not the batch's initial step.
        processName: it.stageProcess?.name ?? '—',
        itemNumber: it.itemNumber,
        vendorDesignReference: it.vendorDesignReference,
        qty: it.quantity,
        weight: Number(it.totalWeight),
        amount: it.totalCost != null ? Number(it.totalCost) : 0,
        receivedQty: recQty,
        pendingQty: it.closed ? 0 : Math.max(it.quantity - recQty, 0),
        closed: it.closed,
      };
    });

    // Receipts in range (by receipt date) — flattened to item level so the
    // table can share the same columns as Issued/Pending.
    const receiptsRaw = await this.prisma.castingReceipt.findMany({
      where: { vendorId, receiptDate: { gte: fromD, lte: toD } },
      include: {
        items: {
          include: {
            batchItem: { include: { batch: true, stageProcess: true, receiptRows: true } },
          },
        },
      },
      orderBy: { receiptDate: 'asc' },
    });
    const receipts: any[] = [];
    for (const r of receiptsRaw) {
      for (const ri of r.items) {
        const bi = ri.batchItem;
        const totalRecd = bi.receiptRows.reduce((s, x) => s + x.receivedQty, 0);
        receipts.push({
          date: r.receiptDate,
          receiptNumber: r.receiptNumber,
          batchNumber: bi.batch.batchNumber,
          // What this VENDOR did at this stage (not the batch's starting process).
          processName: bi.stageProcess?.name ?? '—',
          itemNumber: bi.itemNumber,
          vendorDesignReference: bi.vendorDesignReference,
          qty: bi.quantity,
          weight: Number(bi.totalWeight),
          recd: ri.receivedQty,
          recdWeight: Number(ri.receivedWeight),
          pending: bi.closed ? 0 : Math.max(bi.quantity - totalRecd, 0),
          amount: bi.totalCost != null ? Number(bi.totalCost) : 0,
        });
      }
    }

    // Outstanding balances = all currently short-closed lines for this vendor (running balance).
    const outClosed = await this.prisma.castingBatchItem.findMany({
      where: { vendorId, closed: true, shortQty: { gt: 0 } },
      include: { batch: true, stageProcess: true },
      orderBy: { closedAt: 'desc' },
    });
    const outstanding = outClosed.map((it) => {
      const shortQty = it.shortQty ?? 0;
      const amount =
        it.totalCost != null && it.quantity > 0
          ? (Number(it.totalCost) * shortQty) / it.quantity
          : 0;
      return {
        date: it.closedAt,
        batchNumber: it.batch.batchNumber,
        // Stage-level process — what the vendor was actually doing when short-closed.
        processName: it.stageProcess?.name ?? '—',
        itemNumber: it.itemNumber,
        reason: it.closedReason,
        shortQty,
        shortWeight: it.shortWeight != null ? Number(it.shortWeight) : 0,
        amount: Math.round(amount * 100) / 100,
      };
    });

    // Currently UNDER PROCESS with this vendor = open stages (any date) issued to
    // them but not yet fully received back — the physical WIP they're holding.
    const openStages = await this.prisma.castingBatchItem.findMany({
      where: { vendorId, closed: false },
      include: { batch: { include: { process: true } }, stageProcess: true, item: true, receiptRows: true },
      orderBy: { id: 'desc' },
    });
    const underProcess: any[] = [];
    for (const it of openStages) {
      const recd = it.receiptRows.reduce((s, x) => s + x.receivedQty, 0);
      const pend = it.quantity - recd;
      if (pend <= 0) continue;
      const recdW = it.receiptRows.reduce((s, x) => s + Number(x.receivedWeight), 0);
      underProcess.push({
        batchNumber: it.batch.batchNumber,
        processName: it.stageProcess?.name ?? it.batch.process?.name ?? '—',
        itemNumber: it.itemNumber,
        designCode: it.item?.sampleDesignCode ?? null,
        color: it.color,
        vendorDesignReference: it.vendorDesignReference,
        pendingQty: pend,
        pendingWeight: Math.max(Math.round((Number(it.totalWeight) - recdW) * 1000) / 1000, 0),
      });
    }

    const sum = (arr: any[], k: string) => arr.reduce((s, x) => s + (Number(x[k]) || 0), 0);
    const summary = {
      issued: { qty: sum(issues, 'qty'), weight: sum(issues, 'weight'), amount: sum(issues, 'amount') },
      received: { qty: sum(receipts, 'recd'), weight: sum(receipts, 'recdWeight') },
      pending: { qty: sum(issues, 'pendingQty') },
      underProcess: { qty: sum(underProcess, 'pendingQty'), weight: Math.round(sum(underProcess, 'pendingWeight') * 1000) / 1000 },
      outstanding: {
        qty: sum(outstanding, 'shortQty'),
        weight: sum(outstanding, 'shortWeight'),
        amount: Math.round(sum(outstanding, 'amount') * 100) / 100,
      },
    };

    return {
      vendor: { id: vendor.id, vendorCode: vendor.vendorCode, vendorName: vendor.vendorName },
      from: fromD,
      to: toD,
      summary,
      issues,
      receipts,
      outstanding,
      underProcess,
    };
  }

  /** Data for a per-vendor PDF. Shows vendor design reference, never the sample code. */
  async vendorPdfData(batchId: number, vendorId: number, processId?: number) {
    const batch = await this.prisma.castingBatch.findUnique({
      where: { id: batchId },
      include: {
        process: true,
        items: { where: { vendorId, ...(processId ? { processId } : {}) }, include: { vendor: true, stageProcess: true } },
      },
    });
    if (!batch || batch.items.length === 0) {
      throw new NotFoundException('No items for this vendor/process in the batch.');
    }
    // A traveler slip is for one process step; show that process in the header.
    const slipProcess = processId ? batch.items[0].stageProcess?.name ?? 'Production' : 'Production';

    const items = await Promise.all(batch.items.map((i) => this.slipItem(i)));

    // Weight-priced steps (Casting/Plating/Antique) keep weight columns; piece-priced
    // steps (Meena/Fitting/Mala/Sticking/Packing/…) show price + total amount instead.
    const firstCode = batch.items[0].stageProcess?.code ?? null;
    const isWeightProcess = firstCode ? KG_PROCESSES.includes(firstCode) : true;

    return {
      batchNumber: batch.batchNumber,
      processName: slipProcess,
      batchDate: batch.batchDate,
      vendor: batch.items[0].vendor,
      isWeightProcess,
      items,
    };
  }

  /** One slip line for a stage. Sticking materials come from the frozen snapshot
   *  (taken at issue) and fall back to the live BOM for older stages. */
  private async slipItem(i: any) {
    let materials:
      | { name: string; variantCode: string | null; required: number; unit: string | null }[]
      | undefined;
    if (i.stageProcess?.code === 'STICKING' && i.itemId) {
      const snap = Array.isArray(i.bomSnapshot) ? i.bomSnapshot : null;
      const src = snap ?? (await this.buildStickingBom(i.itemId, i.quantity, i.color));
      materials = src.map((line: any) => ({
        name: line.variantName,
        variantCode: line.variantCode ?? null,
        required: line.required,
        unit: line.unit ?? null,
      }));
    }
    return {
      vendorDesignReference: i.vendorDesignReference,
      color: i.color ?? null,
      weight: Number(i.weight),
      quantity: i.quantity,
      totalWeight: Number(i.totalWeight),
      price: i.costPerKg != null ? Number(i.costPerKg) : null,
      amount: i.totalCost != null ? Number(i.totalCost) : null,
      remarks: i.remarks ? `${i.stageProcess?.name ?? ''}${i.remarks ? ' · ' + i.remarks : ''}`.trim() : (i.stageProcess?.name ?? null),
      materials,
    };
  }

  /** Issue slip for one slip-group: all stages sharing the same issueSlipId
   *  (issues to the same batch/process/vendor within a 15-minute window). */
  async stagePdfData(stageId: number) {
    const stage = await this.prisma.castingBatchItem.findUnique({
      where: { id: stageId },
      include: { vendor: true, stageProcess: true, batch: true },
    });
    if (!stage) throw new NotFoundException('Stage not found.');
    const slipId = stage.issueSlipId ?? stage.id;
    const grouped = await this.prisma.castingBatchItem.findMany({
      where: { issueSlipId: slipId },
      include: { vendor: true, stageProcess: true, batch: true },
      orderBy: { id: 'asc' },
    });
    const group = grouped.length ? grouped : [stage];
    const first = group[0];
    const code = first.stageProcess?.code ?? null;
    return {
      batchNumber: `${first.batch.batchNumber} · ISS-${slipId}`,
      processName: first.stageProcess?.name ?? 'Production',
      batchDate: first.batch.batchDate,
      vendor: first.vendor,
      isWeightProcess: code ? KG_PROCESSES.includes(code) : true,
      items: await Promise.all(group.map((s) => this.slipItem(s))),
    };
  }

  /** Per-process colour code for an item (e.g. "900002(a)-Lime"); letters reset per process. */
  private async colourCodeFor(itemId: number, processId: number | null, color?: string | null) {
    if (!color || processId == null) return null;
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      include: { processes: { where: { processId }, include: { vendors: { orderBy: { id: 'asc' } } } } },
    });
    const proc = item?.processes[0];
    if (!proc) return null;
    const seen: string[] = [];
    for (const v of proc.vendors) {
      const nm = (v.color ?? '').trim();
      if (nm && !seen.some((s) => s.toLowerCase() === nm.toLowerCase())) seen.push(nm);
    }
    const idx = seen.findIndex((s) => s.toLowerCase() === color.trim().toLowerCase());
    if (idx < 0) return null;
    return `${item?.itemNumber ?? ''}(${String.fromCharCode(97 + idx)})-${color}`;
  }

  /** Data for a per-receipt PDF (a receive slip for one process/vendor). Receipts are
   *  INTERNAL docs, so they DO show our item number + colour + colour code. */
  async receiptPdfData(receiptId: number) {
    const receipt = await this.prisma.castingReceipt.findUnique({
      where: { id: receiptId },
      include: {
        vendor: true,
        batch: true,
        items: { include: { batchItem: { include: { stageProcess: true, item: true } } } },
      },
    });
    if (!receipt) throw new NotFoundException('Receipt not found.');
    const processName = receipt.items[0]?.batchItem.stageProcess?.name ?? 'Production';
    const items = await Promise.all(
      receipt.items.map(async (ri) => {
        const bi = ri.batchItem;
        const colorCode = bi.itemId ? await this.colourCodeFor(bi.itemId, bi.processId, bi.color) : null;
        return {
          itemNumber: bi.item?.itemNumber != null ? String(bi.item.itemNumber) : (bi.itemNumber ?? '—'),
          color: bi.color ?? null,
          colorCode,
          vendorDesignReference: bi.vendorDesignReference,
          weight: Number(bi.weight),
          quantity: ri.receivedQty,
          totalWeight: Number(ri.receivedWeight),
          remarks: ri.remarks ?? bi.stageProcess?.name ?? null,
        };
      }),
    );
    return {
      batchNumber: `${receipt.batch.batchNumber} · ${receipt.receiptNumber}`,
      processName,
      docType: 'Receipt',
      batchDate: receipt.receiptDate,
      vendor: receipt.vendor,
      internal: true, // receipts are internal — show our item number + colour + code
      items,
    };
  }
}
