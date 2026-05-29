import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { nextCode } from '../common/code-generator';
import { UpsertVariantDto, VariantQueryDto } from './dto/material.dto';

@Injectable()
export class MaterialsService {
  constructor(private prisma: PrismaService) {}

  categories() {
    return this.prisma.materialCategory.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
    });
  }

  materials() {
    return this.prisma.material.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, materialCode: true, materialName: true },
      orderBy: { materialName: 'asc' },
    });
  }

  async findAll(query: VariantQueryDto) {
    const where: Prisma.MaterialVariantWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { variantName: { contains: query.search } },
        { variantCode: { contains: query.search } },
        { material: { materialName: { contains: query.search } } },
      ];
    }
    const categoryId = query.categoryId ? Number(query.categoryId) : 0;
    if (categoryId > 0) where.material = { categoryId };

    const variants = await this.prisma.materialVariant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        material: { include: { category: true } },
        vendors: { include: { vendor: { select: { shortName: true } } } },
      },
    });

    return variants.map((v) => ({
      ...v,
      materialName: v.material.materialName,
      materialCode: v.material.materialCode,
      categoryName: v.material.category?.name ?? null,
      categoryId: v.material.categoryId,
      code: this.buildMaterialCode(this.supplierShort(v.vendors), v.material.materialName, v.size, v.color),
      vendorCount: v.vendors.length,
      minPrice: v.vendors.reduce<number | null>((min, vv) => {
        const p = vv.price ? Number(vv.price) : null;
        if (p == null) return min;
        return min == null ? p : Math.min(min, p);
      }, null),
      stockQty: Number(v.stockQty),
      imageUrl: v.imagePath ? `/uploads/${v.imagePath}` : null,
      vendors: undefined,
      material: undefined,
    }));
  }

  /** Supplier short code = preferred vendor's short name, else the first vendor's. */
  private supplierShort(vendors: { isPreferred: boolean; vendor: { shortName: string | null } }[]) {
    if (!vendors.length) return '';
    const chosen = vendors.find((v) => v.isPreferred) ?? vendors[0];
    return chosen.vendor.shortName ?? '';
  }

  /** Generated code: SHORT-MaterialName-Size-Colour (blank segments skipped, spaces stripped). */
  private buildMaterialCode(short: string, material: string, size?: string | null, color?: string | null) {
    return [short, material, size, color]
      .map((s) => (s ?? '').toString().trim().replace(/\s+/g, ''))
      .filter(Boolean)
      .join('-');
  }

  // ---------------- Inventory ----------------
  /** All active variants with current stock + price (for the Inventory page). */
  async stockList(search?: string) {
    const variants = await this.prisma.materialVariant.findMany({
      where: {
        status: 'ACTIVE',
        ...(search
          ? { OR: [{ variantName: { contains: search } }, { variantCode: { contains: search } }, { material: { materialName: { contains: search } } }] }
          : {}),
      },
      include: { material: { include: { category: true } }, vendors: true },
      orderBy: { variantName: 'asc' },
    });
    return variants.map((v) => ({
      id: v.id,
      variantCode: v.variantCode,
      variantName: v.variantName,
      materialName: v.material.materialName,
      categoryName: v.material.category?.name ?? null,
      size: v.size,
      color: v.color,
      unit: v.unit,
      stockQty: Number(v.stockQty),
      price: v.vendors.reduce<number | null>((min, vv) => {
        const p = vv.price ? Number(vv.price) : null;
        return p == null ? min : min == null ? p : Math.min(min, p);
      }, null),
    }));
  }

  /** Apply a stock movement (IN/OUT/ADJUST) and update the running balance. */
  async adjustStock(
    variantId: number,
    body: { type: 'IN' | 'OUT' | 'ADJUST'; quantity: number; note?: string },
    userId?: number,
  ) {
    const variant = await this.prisma.materialVariant.findUnique({ where: { id: variantId } });
    if (!variant) throw new NotFoundException('Variant not found.');
    const current = Number(variant.stockQty);
    const qty = Number(body.quantity || 0);
    // IN adds, OUT removes, ADJUST sets the absolute balance.
    const delta = body.type === 'IN' ? qty : body.type === 'OUT' ? -qty : qty - current;
    const balanceAfter = Math.round((current + delta) * 1000) / 1000;

    await this.prisma.$transaction([
      this.prisma.materialVariant.update({ where: { id: variantId }, data: { stockQty: balanceAfter } }),
      this.prisma.stockMovement.create({
        data: {
          variantId,
          type: body.type,
          quantity: Math.round(delta * 1000) / 1000,
          balanceAfter,
          refType: 'manual',
          note: body.note ?? null,
          createdById: userId ?? null,
        },
      }),
    ]);
    return { id: variantId, stockQty: balanceAfter };
  }

  /** Recent stock movements (optionally for one variant). */
  async movements(variantId?: number, limit = 100) {
    const rows = await this.prisma.stockMovement.findMany({
      where: variantId ? { variantId } : {},
      include: { variant: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((m) => ({
      id: m.id,
      date: m.createdAt,
      variantId: m.variantId,
      variantCode: m.variant.variantCode,
      variantName: m.variant.variantName,
      type: m.type,
      quantity: Number(m.quantity),
      balanceAfter: Number(m.balanceAfter),
      refType: m.refType,
      refId: m.refId,
      note: m.note,
    }));
  }

  async findOne(id: number) {
    const variant = await this.prisma.materialVariant.findUnique({
      where: { id },
      include: {
        material: true,
        vendors: { include: { vendor: true }, orderBy: { id: 'asc' } },
      },
    });
    if (!variant) throw new NotFoundException('Variant not found.');
    return {
      ...variant,
      materialName: variant.material.materialName,
      materialCode: variant.material.materialCode,
      categoryId: variant.material.categoryId,
      code: this.buildMaterialCode(
        this.supplierShort(variant.vendors.map((vv) => ({ isPreferred: vv.isPreferred, vendor: { shortName: vv.vendor.shortName } }))),
        variant.material.materialName,
        variant.size,
        variant.color,
      ),
      stockQty: Number(variant.stockQty),
      imageUrl: variant.imagePath ? `/uploads/${variant.imagePath}` : null,
      vendors: variant.vendors.map((vv) => ({
        id: vv.id,
        vendorId: vv.vendorId,
        vendorCode: vv.vendor.vendorCode,
        vendorName: vv.vendor.vendorName,
        vendorReference: vv.vendorReference,
        price: vv.price ? Number(vv.price) : null,
        moq: vv.moq ? Number(vv.moq) : null,
        isPreferred: vv.isPreferred,
        notes: vv.notes,
      })),
      material: undefined,
    };
  }

  async create(dto: UpsertVariantDto, userId?: number) {
    const materialId = await this.resolveMaterial(dto, userId);
    const variantCode = await nextCode(
      this.prisma,
      'materialVariant',
      'variantCode',
      'MV',
      5,
    );
    const variant = await this.prisma.materialVariant.create({
      data: {
        materialId,
        variantCode,
        ...this.variantFields(dto),
        vendors: { create: this.vendorRows(dto) },
      },
    });
    return { id: variant.id, variantCode: variant.variantCode };
  }

  async update(id: number, dto: UpsertVariantDto, userId?: number) {
    await this.findOne(id);
    const materialId = await this.resolveMaterial(dto, userId);
    await this.prisma.$transaction([
      this.prisma.materialVariant.update({
        where: { id },
        data: { materialId, ...this.variantFields(dto) },
      }),
      this.prisma.materialVariantVendor.deleteMany({ where: { variantId: id } }),
      this.prisma.materialVariantVendor.createMany({
        data: this.vendorRows(dto).map((r) => ({ ...r, variantId: id })),
      }),
    ]);
    return { id };
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.materialVariant.delete({ where: { id } });
    return { id };
  }

  // ---- helpers ----
  private async resolveMaterial(dto: UpsertVariantDto, userId?: number) {
    const existing = await this.prisma.material.findFirst({
      where: { materialName: dto.materialName },
    });
    if (existing) {
      if (dto.categoryId) {
        await this.prisma.material.update({
          where: { id: existing.id },
          data: { categoryId: dto.categoryId },
        });
      }
      return existing.id;
    }
    const materialCode = await nextCode(this.prisma, 'material', 'materialCode', 'M', 4);
    const created = await this.prisma.material.create({
      data: {
        materialCode,
        materialName: dto.materialName,
        categoryId: dto.categoryId ?? null,
        unit: dto.unit ?? null,
        createdById: userId ?? null,
      },
    });
    return created.id;
  }

  private variantFields(dto: UpsertVariantDto) {
    return {
      variantName: dto.variantName,
      size: dto.size ?? null,
      color: dto.color ?? null,
      finish: dto.finish ?? null,
      shape: dto.shape ?? null,
      unit: dto.unit ?? null,
      imagePath: dto.imagePath ?? null,
      notes: dto.notes ?? null,
      status: dto.status ?? 'ACTIVE',
    };
  }

  private vendorRows(dto: UpsertVariantDto) {
    return (dto.vendors ?? [])
      .filter((v) => v.vendorId > 0)
      .map((v) => ({
        vendorId: v.vendorId,
        vendorReference: v.vendorReference ?? null,
        price: v.price ?? null,
        moq: v.moq ?? null,
        isPreferred: v.isPreferred ?? false,
        notes: v.notes ?? null,
      }));
  }
}
