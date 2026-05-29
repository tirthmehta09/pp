import { PrismaService } from '../prisma/prisma.service';

/**
 * Generate the next sequential code for a model, e.g. "V0001", "M0001".
 * Reads the highest existing numeric tail for the given prefix.
 */
export async function nextCode(
  prisma: PrismaService,
  model:
    | 'vendor'
    | 'material'
    | 'materialVariant'
    | 'castingBatch'
    | 'castingReceipt'
    | 'materialIssue',
  field: string,
  prefix: string,
  pad = 4,
): Promise<string> {
  const delegate = prisma[model] as any;
  const last = await delegate.findFirst({
    where: { [field]: { startsWith: prefix } },
    orderBy: { [field]: 'desc' },
    select: { [field]: true },
  });

  let next = 1;
  if (last && last[field]) {
    const tail = parseInt(String(last[field]).replace(/\D/g, ''), 10);
    if (!Number.isNaN(tail)) next = tail + 1;
  }
  return prefix + String(next).padStart(pad, '0');
}
