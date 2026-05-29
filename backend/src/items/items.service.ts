import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertItemDto, ItemQueryDto, ItemProcessDto } from './dto/item.dto';
import {
  PROCESS_ATTRIBUTES,
  COLOUR_PROCESSES,
  COLOR_MODEL_PROCESSES,
  KG_PROCESSES,
  SERVICE_PROCESSES,
  BATCH_ONLY_PROCESSES,
  SUPPLIER_PROCESSES,
  costUnit,
} from '../processes/processes.service';

@Injectable()
export class ItemsService {
  constructor(private prisma: PrismaService) {}

  // Form metadata: processes (+ cost unit / services), vendors, designers, services master.
  async meta() {
    const processes = await this.prisma.process.findMany({
      // Supplier roles (Raw Material Supplier) are not manufacturing steps — keep
      // them out of the Item Master blueprint and the production/batch dropdowns.
      where: { status: 'ACTIVE', code: { notIn: SUPPLIER_PROCESSES } },
      orderBy: { sortOrder: 'asc' },
      include: {
        vendorLinks: {
          include: { vendor: { select: { id: true, vendorCode: true, vendorName: true } } },
        },
      },
    });

    const allVendors = await this.prisma.vendor.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, vendorCode: true, vendorName: true, shortName: true },
      orderBy: { vendorName: 'asc' },
    });

    const services = await this.prisma.processService.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
    });

    // Material variants for the Sticking BOM builder (with price + current stock).
    const variantRows = await this.prisma.materialVariant.findMany({
      where: { status: 'ACTIVE' },
      include: { material: true, vendors: true },
      orderBy: { variantName: 'asc' },
    });
    const variants = variantRows.map((v) => ({
      id: v.id,
      variantCode: v.variantCode,
      variantName: v.variantName,
      materialName: v.material.materialName,
      size: v.size,
      color: v.color,
      unit: v.unit,
      stockQty: Number(v.stockQty),
      price: this.variantPrice(v.vendors),
    }));

    const mapped = processes.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      attributes: PROCESS_ATTRIBUTES[p.code] ?? [],
      usesColor: COLOUR_PROCESSES.includes(p.code),
      colorModelStep: COLOR_MODEL_PROCESSES.includes(p.code),
      usesServices: SERVICE_PROCESSES.includes(p.code),
      batchOnly: BATCH_ONLY_PROCESSES.includes(p.code),
      costUnit: costUnit(p.code),
      vendors: p.vendorLinks.map((l) => l.vendor),
    }));

    // Designers = vendors who support the Design/CAD process (with short names).
    const designProc = processes.find((p) => p.code === 'DESIGN_CAD');
    const designers = (designProc?.vendorLinks ?? []).map((l) => ({
      id: l.vendor.id,
      vendorCode: l.vendor.vendorCode,
      vendorName: l.vendor.vendorName,
      shortName: allVendors.find((v) => v.id === l.vendor.id)?.shortName ?? null,
    }));

    return {
      processes: mapped,
      allVendors,
      designers,
      services: services.map((s) => ({ id: s.id, code: s.code, name: s.name, appliesTo: s.appliesTo })),
      variants,
      sampleStatuses: ['DRAFT', 'IN_DEVELOPMENT', 'SAMPLE_READY', 'PRODUCTION_READY'],
    };
  }

  /** Preferred vendor price, else the cheapest mapped price, else 0. */
  private variantPrice(vendors: { price: any; isPreferred: boolean }[]): number {
    const preferred = vendors.find((v) => v.isPreferred && v.price != null);
    if (preferred) return Number(preferred.price);
    const prices = vendors.map((v) => (v.price != null ? Number(v.price) : null)).filter((p): p is number => p != null);
    return prices.length ? Math.min(...prices) : 0;
  }

  /** Preview the next sample design code for a designer short name (e.g. TVM-003). */
  async nextDesignCode(shortName?: string) {
    return { sampleDesignCode: await this.generateDesignCode(shortName) };
  }

  async findAll(query: ItemQueryDto) {
    const where: Prisma.ItemWhereInput = {};
    if (query.sampleStatus) where.sampleStatus = query.sampleStatus;
    if (query.category) where.category = query.category;
    if (query.search) {
      where.OR = [
        { sampleDesignCode: { contains: query.search } },
        { collection: { contains: query.search } },
      ];
    }

    const items = await this.prisma.item.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 1 },
      },
    });

    return items.map((i) => ({
      id: i.id,
      sampleDesignCode: i.sampleDesignCode,
      itemNumber: i.itemNumber,
      category: i.category,
      collection: i.collection,
      designType: i.designType,
      designerName: i.designerName,
      sellingPrice: i.sellingPrice ? Number(i.sellingPrice) : null,
      costPrice: i.costPrice ? Number(i.costPrice) : null,
      sampleStatus: i.sampleStatus,
      updatedAt: i.updatedAt,
      thumbUrl: i.images[0] ? `/uploads/${i.images[0].filePath}` : null,
    }));
  }

  async findOne(id: number) {
    const item = await this.prisma.item.findUnique({
      where: { id },
      include: {
        images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
        processes: {
          include: {
            process: true,
            attributes: true,
            vendors: { include: { vendor: true }, orderBy: { id: 'asc' } },
            photos: { where: { itemProcessVendorId: null } },
            services: { include: { service: true } },
          },
          orderBy: { process: { sortOrder: 'asc' } },
        },
        materials: { include: { variant: { include: { material: true, vendors: true } } } },
        colorModels: { include: { processColors: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!item) throw new NotFoundException('Item not found.');

    // Colour codes reset PER PROCESS: each colour process letters its own colours
    // a/b/c → `{itemNumber}({letter})-{name}` (Plating(a) and Meena(a) are separate).
    const colourLetters = new Map<string, string>(); // `${itemProcessId}:${name}` -> letter
    for (const p of item.processes) {
      if (!COLOUR_PROCESSES.includes(p.process.code)) continue;
      let i = 0;
      for (const v of p.vendors) {
        const nm = (v.color ?? '').trim();
        if (!nm) continue;
        const key = `${p.id}:${nm.toLowerCase()}`;
        if (!colourLetters.has(key)) { colourLetters.set(key, String.fromCharCode(97 + i)); i++; }
      }
    }
    const colourCode = (itemProcessId: number, name?: string | null) => {
      const nm = (name ?? '').trim();
      const letter = nm ? colourLetters.get(`${itemProcessId}:${nm.toLowerCase()}`) : undefined;
      if (item.itemNumber == null || !letter) return null;
      return `${item.itemNumber}(${letter})-${nm}`;
    };

    return {
      ...item,
      designCost: item.designCost ? Number(item.designCost) : null,
      sellingPrice: item.sellingPrice ? Number(item.sellingPrice) : null,
      costPrice: item.costPrice ? Number(item.costPrice) : null,
      cadFileUrl: item.cadFilePath ? `/uploads/${item.cadFilePath}` : null,
      materials: item.materials.map((m) => {
        const price = this.variantPrice(m.variant.vendors);
        const qty = Number(m.quantity);
        return {
          variantId: m.variantId,
          variantCode: m.variant.variantCode,
          variantName: m.variant.variantName,
          materialName: m.variant.material.materialName,
          size: m.variant.size,
          color: m.variant.color,
          stickingColor: m.color ?? null, // which sticking colour this BOM line is for
          unit: m.unit ?? m.variant.unit,
          quantity: qty,
          price,
          stockQty: Number(m.variant.stockQty),
          lineCost: Math.round(price * qty * 100) / 100,
          notes: m.notes,
        };
      }),
      images: item.images.map((im) => ({
        id: im.id,
        filePath: im.filePath,
        url: `/uploads/${im.filePath}`,
        isPrimary: im.isPrimary,
      })),
      processes: item.processes.map((p) => ({
        itemProcessId: p.id,
        processId: p.processId,
        code: p.process.code,
        name: p.process.name,
        costUnit: costUnit(p.process.code),
        notes: p.notes,
        attributes: Object.fromEntries(p.attributes.map((a) => [a.attrKey, a.attrValue])),
        photos: p.photos.map((ph) => ({ id: ph.id, filePath: ph.filePath, url: `/uploads/${ph.filePath}` })),
        services: p.services.map((s) => ({
          serviceId: s.serviceId,
          name: s.service.name,
          cost: s.cost ? Number(s.cost) : null,
        })),
        vendors: p.vendors.map((v) => ({
          id: v.id,
          vendorId: v.vendorId,
          vendorCode: v.vendor.vendorCode,
          vendorName: v.vendor.vendorName,
          vendorDesignReference: v.vendorDesignReference,
          color: v.color,
          colorPhotoPath: v.colorPhotoPath,
          colorPhotoUrl: v.colorPhotoPath ? `/uploads/${v.colorPhotoPath}` : null,
          colorCode: colourCode(p.id, v.color),
          costPerPiece: v.costPerPiece ? Number(v.costPerPiece) : null,
          isPreferred: v.isPreferred,
          bringsOwnMaterials: v.bringsOwnMaterials,
          notes: v.notes,
        })),
      })),
      colorModels: item.colorModels.map((cm) => ({
        id: cm.id,
        letter: cm.letter,
        name: cm.name,
        photoPath: cm.photoPath,
        photoUrl: cm.photoPath ? `/uploads/${cm.photoPath}` : null,
        costPrice: cm.costPrice != null ? Number(cm.costPrice) : null,
        sellingPrice: cm.sellingPrice != null ? Number(cm.sellingPrice) : null,
        processColors: cm.processColors.map((pc) => ({ processId: pc.processId, color: pc.color })),
      })),
      costBreakup: this.buildCostBreakup(item),
    };
  }

  /** Itemised cost breakup: design + each process (preferred rate) + BOM materials. */
  private buildCostBreakup(item: any) {
    const lines: { label: string; amount: number; excludeFromTotal?: boolean }[] = [];
    const weightG = Number(
      item.processes.find((p: any) => p.process.code === 'CASTING')?.attributes
        ?.find?.((a: any) => a.attrKey === 'weight')?.attrValue ?? 0,
    ) || 0;
    const design = item.designCost ? Number(item.designCost) : 0;
    // Design cost is shown for reference only — it's a one-time amortised cost,
    // NOT added to the per-piece cost price.
    if (design) lines.push({ label: 'Design cost (informational — not in total)', amount: design, excludeFromTotal: true });

    for (const p of item.processes) {
      const code = p.process.code;
      const svc = p.services.reduce((s: number, x: any) => s + (x.cost ? Number(x.cost) : 0), 0);
      const entries = p.vendors;
      const chosen = entries.find((e: any) => e.isPreferred) ?? entries.find((e: any) => e.costPerPiece != null) ?? entries[0];
      const rate = chosen?.costPerPiece != null ? Number(chosen.costPerPiece) : 0;
      const procCost = KG_PROCESSES.includes(code) ? (weightG / 1000) * rate : rate;
      if (procCost) lines.push({ label: `${p.process.name}${KG_PROCESSES.includes(code) ? ' (per kg)' : ''}`, amount: Math.round(procCost * 100) / 100 });
      if (svc) lines.push({ label: `${p.process.name} — services`, amount: svc });
    }

    let bom = 0;
    // BOM is per sticking-colour — cost the PREFERRED (★) sticking colour as representative.
    // BUT skip materials cost entirely when that vendor brings their OWN materials —
    // their per-piece rate (already added above as the process cost) is inclusive.
    const stick = item.processes.find((p: any) => p.process.code === 'STICKING');
    const sv = stick?.vendors ?? [];
    const prefVendor = sv.find((v: any) => v.isPreferred) ?? sv[0];
    const prefColour = (prefVendor?.color ?? '').trim().toLowerCase();
    const bringsOwn = !!prefVendor?.bringsOwnMaterials;
    if (!bringsOwn) {
      for (const m of item.materials.filter((m: any) => ((m.color ?? '').trim().toLowerCase()) === prefColour)) {
        const price = this.variantPrice(m.variant.vendors);
        bom += price * Number(m.quantity);
      }
      if (bom) lines.push({ label: `Sticking materials${prefColour ? ` (${prefColour})` : ''}`, amount: Math.round(bom * 100) / 100 });
    }

    const total = Math.round(lines.reduce((s, l) => s + (l.excludeFromTotal ? 0 : l.amount), 0) * 100) / 100;
    return { lines, total };
  }

  /**
   * Central cost recompute — the single source of truth for an item's cost price.
   * Reads the PERSISTED processes/vendors/attributes/materials and recomputes
   * costPrice from buildCostBreakup, so any path that mutates derived inputs
   * (item save, direct edits, batch colour changes, maintenance) can keep cost
   * correct by calling this instead of relying on a full-form save.
   */
  async recomputeItemCost(id: number): Promise<number> {
    const item = await this.prisma.item.findUnique({
      where: { id },
      include: {
        processes: {
          include: { process: true, attributes: true, vendors: { include: { vendor: true } }, services: { include: { service: true } } },
          orderBy: { process: { sortOrder: 'asc' } },
        },
        materials: { include: { variant: { include: { vendors: true } } } },
      },
    });
    if (!item) throw new NotFoundException('Item not found.');
    const total = this.buildCostBreakup(item).total;
    await this.prisma.item.update({ where: { id }, data: { costPrice: total } });
    return total;
  }

  /** Recompute cost price for every item (maintenance / after bulk data changes). */
  async recomputeAllCosts(): Promise<{ updated: number }> {
    const ids = await this.prisma.item.findMany({ select: { id: true } });
    for (const { id } of ids) await this.recomputeItemCost(id);
    return { updated: ids.length };
  }

  async create(dto: UpsertItemDto, userId?: number) {
    // Friendly duplicate check (before hitting the DB constraint).
    if (dto.itemNumber) {
      const dup = await this.prisma.item.findUnique({ where: { itemNumber: dto.itemNumber } });
      if (dup) throw new BadRequestException(`Item number "${dto.itemNumber}" is already used by ${dup.sampleDesignCode}. Choose a unique number.`);
    }
    const sampleDesignCode = await this.generateDesignCode(dto.designerShortName);
    const item = await this.prisma.item.create({
      data: {
        sampleDesignCode,
        ...this.basicFields(dto),
        costPrice: 0, // set centrally below from persisted entities
        createdById: userId ?? null,
      },
    });
    await this.syncImages(item.id, dto.images);
    await this.syncProcesses(item.id, dto.processes ?? []);
    await this.syncMaterials(item.id, dto.materials ?? []);
    await this.syncColorModels(item.id, dto.colorModels ?? []);
    await this.recomputeItemCost(item.id); // single source of truth
    await this.logStatus(item.id, null, item.sampleStatus, userId);
    return { id: item.id, sampleDesignCode };
  }

  async update(id: number, dto: UpsertItemDto, userId?: number) {
    const current = await this.prisma.item.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Item not found.');
    if (dto.itemNumber && dto.itemNumber !== current.itemNumber) {
      const dup = await this.prisma.item.findUnique({ where: { itemNumber: dto.itemNumber } });
      if (dup && dup.id !== id) throw new BadRequestException(`Item number "${dto.itemNumber}" is already used by ${dup.sampleDesignCode}. Choose a unique number.`);
    }

    await this.prisma.item.update({ where: { id }, data: { ...this.basicFields(dto) } });
    await this.syncImages(id, dto.images);
    await this.syncProcesses(id, dto.processes ?? []);
    await this.syncMaterials(id, dto.materials ?? []);
    await this.syncColorModels(id, dto.colorModels ?? []);
    await this.recomputeItemCost(id); // recompute from persisted entities
    if (dto.sampleStatus && dto.sampleStatus !== current.sampleStatus) {
      await this.logStatus(id, current.sampleStatus, dto.sampleStatus, userId);
    }
    return { id, sampleDesignCode: current.sampleDesignCode };
  }

  /**
   * Material cost for the item's cost price. BOM is per sticking-colour, so we use
   * the PREFERRED sticking colour's BOM (the ★ colour) as the representative cost.
   */
  private async syncMaterials(itemId: number, materials: NonNullable<UpsertItemDto['materials']>) {
    await this.prisma.itemMaterial.deleteMany({ where: { itemId } });
    const rows = materials
      .filter((m) => m.variantId > 0)
      .map((m) => ({
        itemId,
        variantId: m.variantId,
        color: m.color ?? null,
        quantity: m.quantity ?? 0,
        wastagePercent: m.wastagePercent ?? 0,
        unit: m.unit ?? null,
        notes: m.notes ?? null,
      }));
    if (rows.length) await this.prisma.itemMaterial.createMany({ data: rows });
  }

  /** Replace an item's colour models (+ per-process colours). */
  private async syncColorModels(itemId: number, models: NonNullable<UpsertItemDto['colorModels']>) {
    await this.prisma.itemColorModel.deleteMany({ where: { itemId } });
    let order = 0;
    for (const m of models) {
      if (!m.name || !m.name.trim()) continue;
      const letter = (m.letter && m.letter.trim()) || String.fromCharCode(97 + order); // a, b, c…
      await this.prisma.itemColorModel.create({
        data: {
          itemId,
          letter,
          name: m.name.trim(),
          photoPath: m.photoPath ?? null,
          costPrice: m.costPrice ?? null,
          sellingPrice: m.sellingPrice ?? null,
          sortOrder: order,
          processColors: {
            create: (m.processColors ?? [])
              .filter((pc) => pc.processId > 0 && pc.color && pc.color.trim())
              .map((pc) => ({ processId: pc.processId, color: pc.color.trim() })),
          },
        },
      });
      order++;
    }
  }

  async remove(id: number) {
    await this.prisma.item.findUniqueOrThrow({ where: { id } }).catch(() => {
      throw new NotFoundException('Item not found.');
    });
    await this.prisma.item.delete({ where: { id } });
    return { id };
  }

  async deleteImage(itemId: number, imageId: number) {
    await this.prisma.itemImage.deleteMany({ where: { id: imageId, itemId } });
    return { id: imageId };
  }

  // ---- helpers ----
  private async generateDesignCode(shortName?: string): Promise<string> {
    const prefix = (shortName?.trim() || 'GEN').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'GEN';
    const last = await this.prisma.item.findFirst({
      where: { sampleDesignCode: { startsWith: `${prefix}-` } },
      orderBy: { sampleDesignCode: 'desc' },
      select: { sampleDesignCode: true },
    });
    let n = 1;
    if (last) {
      const tail = parseInt(last.sampleDesignCode.split('-')[1] ?? '0', 10);
      if (!Number.isNaN(tail)) n = tail + 1;
    }
    return `${prefix}-${String(n).padStart(3, '0')}`;
  }

  /**
   * Auto cost price = design cost
   *   + Σ services cost
   *   + Σ (per process: preferred entry rate; KG processes → weight(kg) × cost/kg,
   *        piece processes → cost/piece). Weight comes from Casting's weight attribute (grams).
   */
  private basicFields(dto: UpsertItemDto) {
    return {
      itemNumber: dto.itemNumber ?? null,
      category: dto.category ?? null,
      subcategory: dto.subcategory ?? null,
      collection: dto.collection ?? null,
      notes: dto.notes ?? null,
      designType: dto.designType ?? null,
      designerName: dto.designerName ?? null,
      designerShortName: dto.designerShortName ?? null,
      designCost: dto.designCost ?? null,
      sellingPrice: dto.sellingPrice ?? null,
      cadFilePath: dto.cadFilePath ?? undefined,
      sampleStatus: dto.sampleStatus ?? 'DRAFT',
    };
  }

  private async syncImages(itemId: number, images?: string[]) {
    if (!images) return;
    const existing = await this.prisma.itemImage.findMany({ where: { itemId } });
    const existingPaths = new Set(existing.map((e) => e.filePath));
    let hasPrimary = existing.some((e) => e.isPrimary);
    let order = existing.length;
    for (const path of images) {
      if (existingPaths.has(path)) continue;
      await this.prisma.itemImage.create({
        data: { itemId, filePath: path, isPrimary: !hasPrimary, sortOrder: order++ },
      });
      hasPrimary = true;
    }
  }

  private async syncProcesses(itemId: number, processes: ItemProcessDto[]) {
    for (const proc of processes) {
      if (!proc.processId) continue;

      const attrs = Object.entries(proc.attributes ?? {}).filter(
        ([, v]) => v != null && String(v).trim() !== '',
      );
      const vendors = (proc.vendors ?? []).filter((v) => v.vendorId > 0);
      const services = (proc.services ?? []).filter((s) => s.serviceId > 0);
      const processPhotos = (proc.photos ?? []).filter(Boolean);
      const hasData =
        (proc.notes && proc.notes.trim() !== '') ||
        attrs.length > 0 ||
        vendors.length > 0 ||
        services.length > 0 ||
        processPhotos.length > 0;

      if (!hasData) {
        await this.prisma.itemProcess.deleteMany({ where: { itemId, processId: proc.processId } });
        continue;
      }

      const ip = await this.prisma.itemProcess.upsert({
        where: { itemId_processId: { itemId, processId: proc.processId } },
        update: { notes: proc.notes ?? null },
        create: { itemId, processId: proc.processId, notes: proc.notes ?? null },
      });

      // Attributes (replace)
      await this.prisma.itemProcessAttribute.deleteMany({ where: { itemProcessId: ip.id } });
      if (attrs.length) {
        await this.prisma.itemProcessAttribute.createMany({
          data: attrs.map(([k, v]) => ({
            itemProcessId: ip.id,
            attrKey: k.toLowerCase().replace(/[^a-z0-9_]/g, ''),
            attrValue: String(v),
          })),
        });
      }

      // Vendor / colour entries (replace). Photos live only at process level now.
      await this.prisma.itemProcessVendor.deleteMany({ where: { itemProcessId: ip.id } });
      if (vendors.length) {
        await this.prisma.itemProcessVendor.createMany({
          data: vendors.map((v) => ({
            itemProcessId: ip.id,
            vendorId: v.vendorId,
            vendorDesignReference: v.vendorDesignReference ?? null,
            color: v.color ?? null,
            colorPhotoPath: v.colorPhotoPath ?? null,
            costPerPiece: v.costPerPiece ?? null,
            isPreferred: v.isPreferred ?? false,
            bringsOwnMaterials: v.bringsOwnMaterials ?? false,
            notes: v.notes ?? null,
          })),
        });
      }

      // Services (replace)
      await this.prisma.itemProcessService.deleteMany({ where: { itemProcessId: ip.id } });
      if (services.length) {
        await this.prisma.itemProcessService.createMany({
          data: services.map((s) => ({
            itemProcessId: ip.id,
            serviceId: s.serviceId,
            cost: s.cost ?? null,
          })),
        });
      }

      // Process-level photos (replace)
      await this.prisma.processPhoto.deleteMany({
        where: { itemProcessId: ip.id, itemProcessVendorId: null },
      });
      if (processPhotos.length) {
        await this.prisma.processPhoto.createMany({
          data: processPhotos.map((filePath) => ({ itemProcessId: ip.id, filePath })),
        });
      }
    }
  }

  private async logStatus(recordId: number, oldStatus: string | null, newStatus: string, userId?: number) {
    await this.prisma.statusHistory.create({
      data: { module: 'items', recordId, oldStatus, newStatus, changedById: userId ?? null },
    });
  }
}
