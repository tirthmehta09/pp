import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

export class MaterialIssueLineDto {
  @IsInt() variantId!: number;
  // Issued qty is ALWAYS a whole number — you give N stones / pearls / chains, never a fraction.
  @IsInt() issuedQty!: number;
  @IsOptional() @IsString() notes?: string;
}

export class CreateMaterialIssueDto {
  @IsInt() vendorId!: number;
  @IsOptional() @IsInt() batchId?: number;
  @IsOptional() @IsInt() stageId?: number;
  @IsOptional() @IsString() issueDate?: string;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => MaterialIssueLineDto)
  lines!: MaterialIssueLineDto[];
}

export class ReturnLineDto {
  @IsInt() lineId!: number;
  @IsInt() returnedQty!: number; // whole number being physically returned
  // Vendor consumed in production but didn't return (e.g. wastage). When set,
  // these pieces are written off — no stock movement IN, pending drops to 0.
  @IsOptional() @IsInt() consumedQty?: number;
  @IsOptional() @IsString() notes?: string;
}

export class RecordReturnDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReturnLineDto)
  lines!: ReturnLineDto[];
  @IsOptional() @IsString() notes?: string;
}

export class CloseIssueDto {
  @IsOptional() @IsString() @MaxLength(255) reason?: string;
}
