import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Default admin (username: admin / password: admin123)
  const passwordHash = await bcrypt.hash('admin123', 10);
  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      email: 'admin@jewelleryerp.local',
      passwordHash,
      fullName: 'System Administrator',
      role: UserRole.ADMIN,
    },
  });

  // Process master (manufacturing / job-work sequence)
  // General display order used everywhere (vendors, item master, batches, ledger).
  // The actual manufacturing route need not follow this — it's just the standard ordering.
  const processes = [
    { code: 'DESIGN_CAD', name: 'Design/CAD', sortOrder: 1 },
    { code: 'CASTING', name: 'Casting', sortOrder: 2 },
    { code: 'PLATING', name: 'Plating', sortOrder: 3 },
    { code: 'ANTIQUE', name: 'Antique', sortOrder: 4 }, // batch-only, priced per KG
    { code: 'MEENA', name: 'Meena', sortOrder: 5 },
    { code: 'KACHU_FITTING', name: 'Kachu Fitting', sortOrder: 6 },
    { code: 'FITTING', name: 'Fitting', sortOrder: 7 },
    { code: 'MALA', name: 'Mala', sortOrder: 8 },
    { code: 'STICKING', name: 'Sticking', sortOrder: 9 },
    { code: 'PACKING', name: 'Packing', sortOrder: 10 },
    // Supplier role (not a manufacturing step) — feeds Sticking BOM materials.
    { code: 'RAW_MATERIAL_SUPPLIER', name: 'Raw Material Supplier', sortOrder: 11 },
  ];
  for (const p of processes) {
    await prisma.process.upsert({
      where: { code: p.code },
      update: { name: p.name, sortOrder: p.sortOrder, status: 'ACTIVE' },
      create: p,
    });
  }

  // Optional casting services (extensible — add more rows anytime).
  const services = [
    { code: 'SOLDERING', name: 'Soldering', appliesTo: 'CASTING' },
    { code: 'FITTING_SVC', name: 'Fitting', appliesTo: 'CASTING' },
  ];
  for (const s of services) {
    await prisma.processService.upsert({
      where: { code: s.code },
      update: { name: s.name, appliesTo: s.appliesTo, status: 'ACTIVE' },
      create: s,
    });
  }

  // Finishing process removed in this phase — retire it (deactivate if it has
  // history, otherwise delete) so it disappears from forms and vendor roles.
  const finishing = await prisma.process.findUnique({ where: { code: 'FINISHING' } });
  if (finishing) {
    const used = await prisma.itemProcess.count({ where: { processId: finishing.id } });
    if (used > 0) {
      await prisma.process.update({ where: { id: finishing.id }, data: { status: 'INACTIVE' } });
    } else {
      await prisma.vendorProcess.deleteMany({ where: { processId: finishing.id } });
      await prisma.process.delete({ where: { id: finishing.id } });
    }
  }

  // Material categories
  const categories = [
    'Stones', 'Pearls', 'Hooks', 'Chains', 'Beads',
    'Meena Colors', 'Metal Parts', 'Packaging',
  ];
  for (const name of categories) {
    await prisma.materialCategory.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  // -------- Sample vendors --------
  // Map process code -> id for assigning supported processes.
  const allProcesses = await prisma.process.findMany({ where: { status: 'ACTIVE' } });
  const procByCode = new Map(allProcesses.map((p) => [p.code, p.id]));
  const allCodes = allProcesses.map((p) => p.code);

  // One specialist vendor per process type + a few full-service vendors.
  const vendorSpecs: { name: string; short: string; codes: string[] }[] = [
    { name: 'Design Studio CAD', short: 'DSC', codes: ['DESIGN_CAD'] },
    { name: 'Precision Casting Works', short: 'PCW', codes: ['CASTING'] },
    { name: 'Shine Plating House', short: 'SPH', codes: ['PLATING'] },
    { name: 'Meena Art Colors', short: 'MAC', codes: ['MEENA'] },
    { name: 'Kachu Fitting Co', short: 'KFC', codes: ['KACHU_FITTING'] },
    { name: 'Perfect Fitting Co', short: 'PFC', codes: ['FITTING'] },
    { name: 'Sticky Solutions', short: 'SST', codes: ['STICKING'] },
    { name: 'Mala Stringing Works', short: 'MSW', codes: ['MALA'] },
    // Raw material suppliers (feed the Sticking BOM)
    { name: 'Gem Stones Supplier', short: 'GSS', codes: ['RAW_MATERIAL_SUPPLIER'] },
    { name: 'Beads & Findings Mart', short: 'BFM', codes: ['RAW_MATERIAL_SUPPLIER'] },
    // Full-service vendors (support every process)
    { name: 'Supreme Jewels Mfg', short: 'SJM', codes: allCodes },
    { name: 'Royal Manufacturing', short: 'RML', codes: allCodes },
    { name: 'Galaxy Jewellery Works', short: 'GJW', codes: allCodes },
  ];

  // Compute the next vendor code from existing ones.
  const lastVendor = await prisma.vendor.findFirst({
    orderBy: { vendorCode: 'desc' },
    where: { vendorCode: { startsWith: 'V' } },
  });
  let seq = lastVendor ? parseInt(lastVendor.vendorCode.replace(/\D/g, ''), 10) || 0 : 0;

  for (const spec of vendorSpecs) {
    const exists = await prisma.vendor.findFirst({ where: { vendorName: spec.name } });
    if (exists) continue;
    seq += 1;
    const vendorCode = 'V' + String(seq).padStart(4, '0');
    await prisma.vendor.create({
      data: {
        vendorCode,
        vendorName: spec.name,
        shortName: spec.short,
        status: 'ACTIVE',
        processes: {
          create: spec.codes
            .filter((c) => procByCode.has(c))
            .map((c) => ({ processId: procByCode.get(c)! })),
        },
      },
    });
  }

  // Ensure full-service vendors support every active process (incl. newly added
  // ones like Antique) even if they already existed before that process was added.
  const fullServiceNames = ['Supreme Jewels Mfg', 'Royal Manufacturing', 'Galaxy Jewellery Works'];
  for (const name of fullServiceNames) {
    const vendor = await prisma.vendor.findFirst({ where: { vendorName: name } });
    if (!vendor) continue;
    for (const p of allProcesses) {
      await prisma.vendorProcess.upsert({
        where: { vendorId_processId: { vendorId: vendor.id, processId: p.id } },
        update: {},
        create: { vendorId: vendor.id, processId: p.id },
      });
    }
  }

  console.log('Seed complete. Login with admin / admin123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
