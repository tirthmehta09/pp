import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { nextCode } from '../common/code-generator';
import { UpsertVendorDto, VendorQueryDto } from './dto/vendor.dto';

@Injectable()
export class VendorsService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: VendorQueryDto) {
    const where: Prisma.VendorWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { vendorName: { contains: query.search } },
        { vendorCode: { contains: query.search } },
        { shortName: { contains: query.search } },
        { mobile: { contains: query.search } },
      ];
    }
    const processId = query.processId ? Number(query.processId) : 0;
    if (processId > 0) {
      where.processes = { some: { processId } };
    }

    const vendors = await this.prisma.vendor.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { processes: { include: { process: true } } },
    });

    return vendors.map((v) => ({
      ...v,
      processNames: v.processes
        .map((p) => p.process.name)
        .sort()
        .join(', '),
      processIds: v.processes.map((p) => p.processId),
      processes: undefined,
    }));
  }

  async findOne(id: number) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id },
      include: { processes: true },
    });
    if (!vendor) throw new NotFoundException('Vendor not found.');
    return {
      ...vendor,
      processIds: vendor.processes.map((p) => p.processId),
      processes: undefined,
    };
  }

  async create(dto: UpsertVendorDto, userId?: number) {
    const vendorCode = await nextCode(this.prisma, 'vendor', 'vendorCode', 'V', 4);
    const vendor = await this.prisma.vendor.create({
      data: {
        vendorCode,
        ...this.mapFields(dto),
        createdById: userId ?? null,
        processes: {
          create: (dto.processIds ?? []).map((processId) => ({ processId })),
        },
      },
    });
    return { id: vendor.id, vendorCode: vendor.vendorCode };
  }

  async update(id: number, dto: UpsertVendorDto) {
    await this.findOne(id);
    await this.prisma.$transaction([
      this.prisma.vendor.update({ where: { id }, data: this.mapFields(dto) }),
      this.prisma.vendorProcess.deleteMany({ where: { vendorId: id } }),
      this.prisma.vendorProcess.createMany({
        data: (dto.processIds ?? []).map((processId) => ({
          vendorId: id,
          processId,
        })),
        skipDuplicates: true,
      }),
    ]);
    return { id };
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.vendor.delete({ where: { id } });
    return { id };
  }

  private mapFields(dto: UpsertVendorDto) {
    return {
      vendorName: dto.vendorName,
      shortName: dto.shortName ?? null,
      contactPerson: dto.contactPerson ?? null,
      mobile: dto.mobile ?? null,
      email: dto.email ?? null,
      address: dto.address ?? null,
      gstNumber: dto.gstNumber ?? null,
      panNumber: dto.panNumber ?? null,
      notes: dto.notes ?? null,
      status: dto.status ?? 'ACTIVE',
    };
  }
}
