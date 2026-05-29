import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class CastingBatchItemDto {
  @IsOptional() @IsInt() id?: number; // existing batch-item id (edit)
  @IsOptional() @IsInt() itemId?: number; // link to Item Master (drives auto-fetch)
  @IsInt() quantity!: number;
  // Optional overrides — when omitted, the server derives them from the item's
  // process data for the batch's process (preferred vendor, weight, cost/kg…).
  @IsOptional() @IsInt() vendorId?: number;
  @IsOptional() @IsString() @MaxLength(60) itemNumber?: string;
  @IsOptional() @IsString() @MaxLength(150) itemName?: string;
  @IsOptional() @IsString() @MaxLength(80) vendorDesignReference?: string;
  @IsOptional() @IsNumber() weight?: number;
  @IsOptional() @IsNumber() totalWeight?: number; // manual override (editable for KG processes)
  @IsOptional() @IsNumber() costPerKg?: number;
  @IsOptional() @IsString() remarks?: string;
  @IsOptional() @IsString() @MaxLength(120) colorModel?: string; // chosen colour model snapshot
  @IsOptional() @IsString() @MaxLength(60) color?: string;
}

export class CreateBatchDto {
  @IsOptional() @IsString() @MaxLength(40) batchNumber?: string; // auto if omitted
  // Production batches always start at Casting; processId optional (defaults to Casting).
  @IsOptional() @IsInt() processId?: number;
  @IsString() batchDate!: string;
  @IsOptional() @IsString() notes?: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => CastingBatchItemDto)
  items!: CastingBatchItemDto[];
}

// Edit an existing stage (vendor/qty/weight/rate/colour/remarks). History (receipts)
// is preserved; the stage's slip is regenerated live from the updated values.
export class UpdateStageDto {
  @IsOptional() @IsInt() vendorId?: number;
  @IsOptional() @IsString() @MaxLength(80) vendorDesignReference?: string;
  @IsOptional() @IsInt() quantity?: number;
  @IsOptional() @IsNumber() weight?: number;
  @IsOptional() @IsNumber() totalWeight?: number;
  @IsOptional() @IsNumber() costPerKg?: number;
  @IsOptional() @IsString() @MaxLength(60) color?: string;
  @IsOptional() @IsString() remarks?: string;
}

// Forward received pieces of a stage to the next process (any order, partial OK).
export class ForwardStageDto {
  @IsInt() processId!: number; // next process
  @IsInt() quantity!: number;
  @IsOptional() @IsInt() vendorId?: number;
  @IsOptional() @IsNumber() weight?: number; // updated per-piece weight for the NEXT process
  @IsOptional() @IsNumber() totalWeight?: number;
  @IsOptional() @IsNumber() costPerKg?: number; // rate/kg for KG processes (Casting/Plating/Antique)
  @IsOptional() @IsString() @MaxLength(60) color?: string;
  @IsOptional() @IsString() @MaxLength(80) vendorDesignReference?: string;
  @IsOptional() @IsString() remarks?: string;
  // Sticking only: if true, the karigar uses their OWN raw materials (no material
  // issue voucher is created and our stock isn't touched).
  @IsOptional() @IsBoolean() bringsOwnMaterials?: boolean;
  // Sticking only: extra "buffer" pieces to issue on top of the BOM requirement
  // (e.g., we send 1000 stones when 720 are needed). Whole number. Applied per
  // BOM line proportionally — simplest is a flat multiplier on each line qty.
  @IsOptional() @IsNumber() materialBufferPercent?: number;
  // Sticking only: explicit per-variant issue quantities asked at issue time.
  // When provided, these override the BOM × buffer auto-calculation entirely.
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MaterialIssueOverrideDto)
  materialIssueOverride?: MaterialIssueOverrideDto[];
}

export class MaterialIssueOverrideDto {
  @IsInt() variantId!: number;
  @IsInt() issuedQty!: number; // whole pcs
}

export class BatchQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() status?: string;
}

export class CastingReceiptItemDto {
  @IsInt() batchItemId!: number;
  @IsOptional() @IsInt() receivedQty?: number;
  @IsOptional() @IsNumber() receivedWeight?: number;
  @IsOptional() @IsString() remarks?: string;
}

export class CreateReceiptDto {
  @IsInt() batchId!: number;
  @IsInt() vendorId!: number;
  @IsString() receiptDate!: string;
  @IsOptional() @IsString() notes?: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => CastingReceiptItemDto)
  items!: CastingReceiptItemDto[];
}

export class ReceiptQueryDto {
  @IsOptional() @IsString() search?: string; // batch number or vendor name
}
