import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DesignType, SampleStatus } from '@prisma/client';

export class ItemProcessServiceDto {
  @IsInt() serviceId!: number;
  @IsOptional() @IsNumber() cost?: number;
}

// BOM line — material variant stuck onto the design (defined in the Sticking section).
export class ItemMaterialDto {
  @IsInt() variantId!: number;
  // Per-piece quantity is a WHOLE number — you stick N pearls/stones/jump-rings per piece, never a fraction.
  @IsInt() quantity!: number;
  @IsOptional() @IsNumber() wastagePercent?: number;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsString() @MaxLength(80) color?: string; // sticking colour this BOM belongs to
  @IsOptional() @IsString() notes?: string;
}

export class ItemProcessVendorDto {
  @IsInt() vendorId!: number;
  @IsOptional() @IsString() @MaxLength(80) vendorDesignReference?: string;
  @IsOptional() @IsString() @MaxLength(80) color?: string; // colour for this row
  @IsOptional() @IsString() @MaxLength(255) colorPhotoPath?: string; // photo of the colour
  // Rate: cost/kg for KG processes (casting/plating/meena), else cost/piece.
  @IsOptional() @IsNumber() costPerPiece?: number;
  @IsOptional() @IsBoolean() isPreferred?: boolean;
  // Sticking only: vendor brings their own raw materials → rate covers materials,
  // BOM cost is NOT added to the item cost and no material issue is auto-created.
  @IsOptional() @IsBoolean() bringsOwnMaterials?: boolean;
  @IsOptional() @IsString() notes?: string;
}

export class ItemProcessDto {
  @IsInt() processId!: number;
  @IsOptional() @IsString() notes?: string;

  // EAV attributes: { weight: "12.5", metal_type: "Brass", ... }
  @IsOptional() @IsObject() attributes?: Record<string, string>;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemProcessVendorDto)
  vendors?: ItemProcessVendorDto[];

  // Optional services selected on this process (e.g. Casting → Soldering/Fitting).
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemProcessServiceDto)
  services?: ItemProcessServiceDto[];

  // Process-level progress / development photos (relative paths).
  @IsOptional() @IsArray() @IsString({ each: true }) photos?: string[];
}

export class ColorModelProcessDto {
  @IsInt() processId!: number;
  @IsString() @MaxLength(60) color!: string;
}

export class ItemColorModelDto {
  @IsOptional() @IsString() @MaxLength(8) letter?: string;
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(255) photoPath?: string;
  @IsOptional() @IsNumber() costPrice?: number;
  @IsOptional() @IsNumber() sellingPrice?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ColorModelProcessDto)
  processColors?: ColorModelProcessDto[];
}

export class UpsertItemDto {
  // sampleDesignCode is auto-generated from the designer short name; not sent on create.
  // itemNumber is now alphanumeric and unique across all items (e.g. "1501", "1501a").
  @IsOptional() @IsString() @MaxLength(40) itemNumber?: string;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  @IsOptional() @IsString() @MaxLength(80) subcategory?: string;
  @IsOptional() @IsString() @MaxLength(80) collection?: string;
  @IsOptional() @IsString() notes?: string;

  // Design section
  @IsOptional() @IsEnum(DesignType) designType?: DesignType;
  @IsOptional() @IsString() @MaxLength(120) designerName?: string;
  @IsOptional() @IsString() @MaxLength(20) designerShortName?: string;
  @IsOptional() @IsNumber() designCost?: number;
  @IsOptional() @IsNumber() sellingPrice?: number;
  @IsOptional() @IsString() @MaxLength(255) cadFilePath?: string;

  @IsOptional() @IsEnum(SampleStatus) sampleStatus?: SampleStatus;

  // Product images: array of already-uploaded relative paths.
  @IsOptional() @IsArray() @IsString({ each: true })
  images?: string[];

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemProcessDto)
  processes?: ItemProcessDto[];

  // BOM — material variants stuck onto the design (the Sticking materials).
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemMaterialDto)
  materials?: ItemMaterialDto[];

  // Colour models — sellable colour variants (a/b/c) with photo + price + per-step colours.
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemColorModelDto)
  colorModels?: ItemColorModelDto[];
}

export class ItemQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsEnum(SampleStatus) sampleStatus?: SampleStatus;
  @IsOptional() @IsString() category?: string;
}
