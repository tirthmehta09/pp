import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { nextCode } from '../common/code-generator';
import {
  CloseIssueDto,
  CreateMaterialIssueDto,
  RecordReturnDto,
} from './dto/material-issue.dto';

/**
 * Material Issue / Return — the formal record of raw materials going to a vendor
 * (e.g. stones to a sticking karigar) and coming back.
 *
 *   Issued qty:   stock OUT  (deducted from variant stockQty, StockMovement OUT)
 *   Received qty: stock IN   (added back to variant stockQty, StockMovement IN)
 *   Short qty:    closed with a balance the vendor owes us (recorded but no stock change)
 *
 * Vendor holdings = Σ (issuedQty − receivedQty) per (vendor, variant) across open issues.
 */
@Injectable()
export class MaterialIssuesService {
  constructor(private prisma: PrismaService) {}

  /** Voucher number generator — MIV-0001, MIV-0002, … */
  async nextVoucherNumber() {
    const num = await nextCode(this.prisma, 'materialIssue', 'voucherNumber', 'MIV', 4);
    return { voucherNumber: num };
  }

  /** Compute the running status of an issue based on its line totals. */
  private deriveStatus(issued: number, received: number, closed: boolean) {
    if (closed) return 'CLOSED' as const;
    if (received === 0) return 'OPEN' as const;
    if (received >= issued) return 'COMPLETED' as const;
    return 'PARTIAL' as const;
  }

  /** Adjust variant stock + log a StockMovement. Both qty and balance are
   *  forced to WHOLE NUMBERS — no fractional materials anywhere. */
  private async moveStock(
    variantId: number,
    delta: number,
    refType: string,
    refId: number,
    note: string,
    userId?: number,
  ) {
    const v = await this.prisma.materialVariant.findUnique({ where: { id: variantId } });
    if (!v) throw new NotFoundException(`Variant ${variantId} not found.`);
    const intDelta = Math.trunc(delta);
    const after = Math.max(0, Math.round(Number(v.stockQty)) + intDelta);
    await this.prisma.$transaction([
      this.prisma.materialVariant.update({ where: { id: variantId }, data: { stockQty: after } }),
      this.prisma.stockMovement.create({
        data: {
          variantId,
          type: intDelta >= 0 ? 'IN' : 'OUT',
          quantity: intDelta,
          balanceAfter: after,
          refType, refId, note,
          createdById: userId ?? null,
        },
      }),
    ]);
  }

  /** Create a new material-issue voucher; deducts stock for each line. */
  async create(dto: CreateMaterialIssueDto, userId?: number) {
    if (!dto.lines?.length) throw new BadRequestException('Add at least one material line.');
    for (const l of dto.lines) {
      if (!Number.isInteger(l.issuedQty) || l.issuedQty <= 0) {
        throw new BadRequestException('Issued qty must be a positive whole number.');
      }
    }

    const voucherNumber = await nextCode(this.prisma, 'materialIssue', 'voucherNumber', 'MIV', 4);
    const issue = await this.prisma.materialIssue.create({
      data: {
        voucherNumber,
        vendorId: dto.vendorId,
        batchId: dto.batchId ?? null,
        stageId: dto.stageId ?? null,
        issueDate: dto.issueDate ? new Date(dto.issueDate) : new Date(),
        notes: dto.notes ?? null,
        createdById: userId ?? null,
        lines: {
          create: dto.lines.map((l) => ({
            variantId: l.variantId,
            issuedQty: l.issuedQty,
            notes: l.notes ?? null,
          })),
        },
      },
      include: { lines: true },
    });

    // Deduct stock for each line.
    for (const line of issue.lines) {
      await this.moveStock(line.variantId, -line.issuedQty, 'material_issue', issue.id,
        `Issued via ${issue.voucherNumber}`, userId);
    }
    return { id: issue.id, voucherNumber: issue.voucherNumber };
  }

  /**
   * Record a return / "all used" from the vendor.
   *
   * Per line, two distinct things can happen at receive time:
   *   - returnedQty: vendor physically returned this many — adds back to stock.
   *   - consumedQty: vendor used it but didn't return (waste / extra usage) —
   *                  written off, no stock movement.
   * Both subtract from pending. The voucher's pendingQty = issued − received
   * − consumed.
   */
  async recordReturn(issueId: number, dto: RecordReturnDto, userId?: number) {
    const issue = await this.prisma.materialIssue.findUnique({
      where: { id: issueId },
      include: { lines: true },
    });
    if (!issue) throw new NotFoundException('Material issue not found.');
    if (issue.status === 'CLOSED') throw new BadRequestException('This voucher is closed.');

    for (const upd of dto.lines) {
      const line = issue.lines.find((l) => l.id === upd.lineId);
      if (!line) throw new NotFoundException(`Line ${upd.lineId} not on this voucher.`);
      const ret = upd.returnedQty ?? 0;
      const cons = upd.consumedQty ?? 0;
      if (!Number.isInteger(ret) || ret < 0) {
        throw new BadRequestException('Returned qty must be a non-negative whole number.');
      }
      if (!Number.isInteger(cons) || cons < 0) {
        throw new BadRequestException('Consumed qty must be a non-negative whole number.');
      }
      if (ret === 0 && cons === 0) continue;
      const remaining = line.issuedQty - line.receivedQty - ((line as any).consumedQty ?? 0);
      if (ret + cons > remaining) {
        throw new BadRequestException(`Line ${upd.lineId}: only ${remaining} pcs pending — cannot return+use ${ret + cons}.`);
      }
      const data: any = {};
      if (ret > 0) data.receivedQty = { increment: ret };
      if (cons > 0) data.consumedQty = { increment: cons };
      await this.prisma.materialIssueLine.update({ where: { id: line.id }, data });
      if (ret > 0) {
        await this.moveStock(line.variantId, ret, 'material_issue_return', issue.id,
          `Returned via ${issue.voucherNumber}`, userId);
      }
      // consumedQty has no stock movement — the vendor used these in
      // production, so they're not coming back into our raw-material inventory.
    }

    // Recompute issue-level status. "Completed" now means received + consumed
    // accounts for everything issued — nothing left pending with the vendor.
    const lines = await this.prisma.materialIssueLine.findMany({ where: { issueId: issue.id } });
    const totalIssued = lines.reduce((s, l) => s + l.issuedQty, 0);
    const totalAccounted = lines.reduce((s, l) => s + l.receivedQty + ((l as any).consumedQty ?? 0), 0);
    await this.prisma.materialIssue.update({
      where: { id: issue.id },
      data: { status: this.deriveStatus(totalIssued, totalAccounted, false) },
    });
    if (dto.notes) {
      await this.prisma.materialIssue.update({ where: { id: issue.id }, data: { notes: dto.notes } });
    }
    return { id: issue.id };
  }

  /**
   * Close the issue — for stage-linked vouchers, the expected consumption (BOM × stage
   * qty) is the legitimate "used" amount; only the qty NEITHER returned NOR consumed
   * is short. For manual issues we treat anything unreturned as short.
   */
  async close(issueId: number, dto: CloseIssueDto) {
    const issue = await this.prisma.materialIssue.findUnique({
      where: { id: issueId },
      include: { lines: true, stage: true },
    });
    if (!issue) throw new NotFoundException('Material issue not found.');
    if (issue.status === 'CLOSED') return { id: issue.id };

    const snap: any[] = Array.isArray(issue.stage?.bomSnapshot) ? (issue.stage!.bomSnapshot as any[]) : [];
    const expectedByVariant = new Map<number, number>();
    for (const s of snap) if (s?.variantId) expectedByVariant.set(s.variantId, Number(s.required ?? 0));

    for (const l of issue.lines) {
      const expected = expectedByVariant.get(l.variantId) ?? 0;
      const short = expected > 0
        ? Math.max(l.issuedQty - l.receivedQty - expected, 0)  // sticking: short = excess unreturned beyond consumption
        : Math.max(l.issuedQty - l.receivedQty, 0);            // manual: everything unreturned is short
      await this.prisma.materialIssueLine.update({ where: { id: l.id }, data: { shortQty: short } });
    }
    await this.prisma.materialIssue.update({
      where: { id: issue.id },
      data: { status: 'CLOSED', closedAt: new Date(), notes: dto?.reason ?? issue.notes },
    });
    return { id: issue.id };
  }

  /** Delete an issue — reverses the stock movements (only allowed for OPEN issues). */
  async remove(issueId: number, userId?: number) {
    const issue = await this.prisma.materialIssue.findUnique({
      where: { id: issueId },
      include: { lines: true },
    });
    if (!issue) throw new NotFoundException('Material issue not found.');
    if (issue.status === 'CLOSED') throw new BadRequestException('Cannot delete a closed voucher.');
    if (issue.lines.some((l) => l.receivedQty > 0)) {
      throw new BadRequestException('Cannot delete a voucher with returns recorded; close it instead.');
    }
    // Reverse the original OUT for each line.
    for (const l of issue.lines) {
      await this.moveStock(l.variantId, l.issuedQty, 'material_issue_delete', issue.id,
        `Reversed delete of ${issue.voucherNumber}`, userId);
    }
    await this.prisma.materialIssue.delete({ where: { id: issue.id } });
    return { id: issue.id };
  }

  async list(params?: { vendorId?: number; status?: string }) {
    const where: any = {};
    if (params?.vendorId) where.vendorId = Number(params.vendorId);
    if (params?.status) where.status = params.status;
    const rows = await this.prisma.materialIssue.findMany({
      where,
      include: { vendor: true, lines: { include: { variant: true } }, batch: true },
      orderBy: { id: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      voucherNumber: r.voucherNumber,
      vendorId: r.vendorId,
      vendorCode: r.vendor.vendorCode,
      vendorName: r.vendor.vendorName,
      batchNumber: r.batch?.batchNumber ?? null,
      stageId: r.stageId,
      issueDate: r.issueDate,
      status: r.status,
      notes: r.notes,
      totalIssued: r.lines.reduce((s, l) => s + l.issuedQty, 0),
      totalReceived: r.lines.reduce((s, l) => s + l.receivedQty, 0),
      totalShort: r.lines.reduce((s, l) => s + (l.shortQty ?? 0), 0),
      lineCount: r.lines.length,
    }));
  }

  async get(id: number) {
    const r = await this.prisma.materialIssue.findUnique({
      where: { id },
      include: {
        vendor: true,
        batch: true,
        lines: { include: { variant: true } },
        // receiptRows needed so we know how many sticking pcs have actually
        // been received — "used" materials are gated on that, not on the
        // stage's ordered qty (vendor hasn't consumed anything until they
        // actually finish the work and we receive it back).
        stage: { include: { item: true, stageProcess: true, receiptRows: true } },
      },
    });
    if (!r) throw new NotFoundException('Material issue not found.');

    // For stage-linked vouchers (sticking auto-issue) we know the BOM per
    // piece from the immutable snapshot. Per-piece is rounded to a whole
    // number — no fractional stones/bits.
    const snap: any[] = Array.isArray(r.stage?.bomSnapshot) ? (r.stage!.bomSnapshot as any[]) : [];
    const perPieceByVariant = new Map<number, number>();
    for (const s of snap) {
      if (!s?.variantId) continue;
      // Prefer perPiece; fall back to required ÷ stageQty for older snapshots.
      const pp = s.perPiece != null
        ? Number(s.perPiece)
        : (r.stage?.quantity ? Number(s.required ?? 0) / r.stage.quantity : 0);
      perPieceByVariant.set(s.variantId, Math.round(pp));
    }

    // How many sticking pieces from this stage have actually been received
    // back? Until that's > 0, no materials are considered "used" — they're
    // sitting with the vendor (the vendor hasn't built anything yet).
    const stickingReceived = (r.stage?.receiptRows ?? []).reduce((s, x) => s + x.receivedQty, 0);

    const usage = r.stage
      ? {
          stageId: r.stage.id,
          batchNumber: r.batch?.batchNumber ?? null,
          itemNumber: r.stage.item?.itemNumber ?? null,
          designCode: r.stage.item?.sampleDesignCode ?? null,
          processName: r.stage.stageProcess?.name ?? null,
          color: r.stage.color ?? null,
          stageQty: r.stage.quantity,
          stickingReceived,
        }
      : null;

    return {
      id: r.id,
      voucherNumber: r.voucherNumber,
      vendor: { id: r.vendor.id, vendorCode: r.vendor.vendorCode, vendorName: r.vendor.vendorName },
      batchId: r.batchId,
      batchNumber: r.batch?.batchNumber ?? null,
      stageId: r.stageId,
      issueDate: r.issueDate,
      status: r.status,
      notes: r.notes,
      usage,
      lines: r.lines.map((l) => {
        const perPiece = perPieceByVariant.get(l.variantId) ?? 0;
        const explicitlyConsumed = (l as any).consumedQty ?? 0;
        // Implicit "used" = BOM-per-piece × sticking pcs received back. The
        // EXPLICIT consumedQty (user marked "all used" at receive time) is
        // separately tracked; together they cap at issued − received so total
        // accounted never exceeds outstanding.
        const implicitUsed = Math.max(0, perPiece * stickingReceived);
        const used = Math.min(implicitUsed + explicitlyConsumed, l.issuedQty - l.receivedQty);
        // Pending = still with the vendor (not received, not consumed).
        const pending = Math.max(l.issuedQty - l.receivedQty - explicitlyConsumed, 0);
        // Total expected consumption (for the "Close Short" math).
        const expected = perPiece * (r.stage?.quantity ?? 0);
        return {
          id: l.id,
          variantId: l.variantId,
          variantCode: l.variant.variantCode,
          variantName: l.variant.variantName,
          unit: l.variant.unit,
          issuedQty: l.issuedQty,
          receivedQty: l.receivedQty,
          consumedQty: explicitlyConsumed,
          expectedConsumed: Math.round(expected),
          usedQty: Math.round(used),
          pendingQty: Math.round(pending),
          shortQty: l.shortQty ?? null,
          notes: l.notes,
        };
      }),
    };
  }

  /** PDF data — either the initial issue voucher or a current status / return slip. */
  async pdfData(id: number, mode: 'ISSUE' | 'STATUS' = 'STATUS') {
    const detail: any = await this.get(id);
    return {
      mode,
      voucherNumber: detail.voucherNumber,
      issueDate: detail.issueDate,
      vendor: { vendorCode: detail.vendor.vendorCode, vendorName: detail.vendor.vendorName },
      batchNumber: detail.batchNumber,
      notes: detail.notes,
      status: detail.status,
      usage: detail.usage,
      lines: detail.lines.map((l: any) => ({
        variantCode: l.variantCode,
        variantName: l.variantName,
        unit: l.unit,
        issuedQty: l.issuedQty,
        usedQty: l.usedQty,
        receivedQty: l.receivedQty,
        pendingQty: l.pendingQty,
        shortQty: l.shortQty,
        notes: l.notes,
      })),
    };
  }

  /**
   * Record a vendor return across ALL their open vouchers in one shot — the
   * holdings card calls this so the user doesn't have to open each voucher
   * one by one when a vendor returns leftover stones from several jobs at once.
   *
   * Distribution: FIFO by issue date. If the vendor holds 200 of variant X
   * across two vouchers (150 from MIV0003 and 50 from MIV0007), returning
   * 180 fills MIV0003 completely and clears 30 of MIV0007. Stock goes back
   * in proportionally, status on each voucher is recomputed.
   */
  async returnFromVendor(
    vendorId: number,
    items: { variantId: number; returnedQty: number }[],
    userId?: number,
  ) {
    if (!items?.length) throw new BadRequestException('Nothing to return.');
    for (const i of items) {
      if (!Number.isInteger(i.returnedQty) || i.returnedQty <= 0) {
        throw new BadRequestException('Returned qty must be a positive whole number.');
      }
    }

    const affectedIssueIds = new Set<number>();
    const summary: { variantId: number; returned: number; allocations: { voucherNumber: string; qty: number }[] }[] = [];

    for (const item of items) {
      // FIFO across all open issues for this vendor + variant.
      const issues = await this.prisma.materialIssue.findMany({
        where: {
          vendorId,
          status: { not: 'CLOSED' },
          lines: { some: { variantId: item.variantId } },
        },
        include: { lines: { where: { variantId: item.variantId } } },
        orderBy: { issueDate: 'asc' },
      });
      const eligibleLines: { issue: typeof issues[number]; line: typeof issues[number]['lines'][number]; pending: number }[] = [];
      for (const issue of issues) {
        for (const line of issue.lines) {
          const pending = line.issuedQty - line.receivedQty;
          if (pending > 0) eligibleLines.push({ issue, line, pending });
        }
      }
      const totalHeld = eligibleLines.reduce((s, x) => s + x.pending, 0);
      if (item.returnedQty > totalHeld) {
        throw new BadRequestException(
          `Cannot return ${item.returnedQty} — vendor only holds ${totalHeld} of this material.`,
        );
      }

      let remaining = item.returnedQty;
      const allocations: { voucherNumber: string; qty: number }[] = [];
      for (const { issue, line, pending } of eligibleLines) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, pending);
        await this.prisma.materialIssueLine.update({
          where: { id: line.id },
          data: { receivedQty: { increment: take } },
        });
        await this.moveStock(
          line.variantId, take, 'material_issue_return', issue.id,
          `Vendor return → ${issue.voucherNumber} (bulk vendor-return)`, userId,
        );
        affectedIssueIds.add(issue.id);
        allocations.push({ voucherNumber: issue.voucherNumber, qty: take });
        remaining -= take;
      }
      summary.push({ variantId: item.variantId, returned: item.returnedQty, allocations });
    }

    // Recompute status on every affected voucher.
    if (affectedIssueIds.size) {
      const allIssues = await this.prisma.materialIssue.findMany({
        where: { id: { in: Array.from(affectedIssueIds) } },
        include: { lines: true },
      });
      for (const i of allIssues) {
        const totalIssued = i.lines.reduce((s, l) => s + l.issuedQty, 0);
        const totalReceived = i.lines.reduce((s, l) => s + l.receivedQty, 0);
        await this.prisma.materialIssue.update({
          where: { id: i.id },
          data: { status: this.deriveStatus(totalIssued, totalReceived, i.status === 'CLOSED') },
        });
      }
    }

    return { items: summary };
  }

  /** What raw materials each vendor is currently holding (open issues, qty pending return). */
  async vendorHoldings(vendorId?: number) {
    const issues = await this.prisma.materialIssue.findMany({
      where: { ...(vendorId ? { vendorId } : {}), status: { not: 'CLOSED' } },
      include: { vendor: true, lines: { include: { variant: true } } },
    });
    type Holding = {
      vendorId: number; vendorCode: string; vendorName: string;
      variantId: number; variantCode: string; variantName: string;
      unit: string | null; qty: number; vouchers: string[];
    };
    const map = new Map<string, Holding>();
    for (const i of issues) {
      for (const l of i.lines) {
        // Holdings only count what the vendor PHYSICALLY still has — explicit
        // consumed (vendor used and wrote off) is no longer holding.
        const pending = l.issuedQty - l.receivedQty - ((l as any).consumedQty ?? 0);
        if (pending <= 0) continue;
        const key = `${i.vendorId}:${l.variantId}`;
        const h = map.get(key) ?? {
          vendorId: i.vendorId, vendorCode: i.vendor.vendorCode, vendorName: i.vendor.vendorName,
          variantId: l.variantId, variantCode: l.variant.variantCode, variantName: l.variant.variantName,
          unit: l.variant.unit, qty: 0, vouchers: [] as string[],
        };
        h.qty += pending;
        if (!h.vouchers.includes(i.voucherNumber)) h.vouchers.push(i.voucherNumber);
        map.set(key, h);
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.vendorName.localeCompare(b.vendorName) || a.variantName.localeCompare(b.variantName),
    );
  }
}
