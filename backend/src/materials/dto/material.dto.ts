import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ActiveStatus } from '@prisma/client';

export class VariantVendorDto {
  @IsInt()
  vendorId!: number;

  @IsOptional() @IsString() @MaxLength(80)
  vendorReference?: string;

  @IsOptional() @IsNumber()
  price?: number;

  @IsOptional() @IsNumber()
  moq?: number;

  @IsOptional() @IsBoolean()
  isPreferred?: boolean;

  @IsOptional() @IsString()
  notes?: string;
}

export class UpsertVariantDto {
  // Parent material resolved/created by name.
  @IsString() @MaxLength(150)
  materialName!: string;

  @IsOptional() @IsInt()
  categoryId?: number;

  @IsString() @MaxLength(150)
  variantName!: string;

  @IsOptional() @IsString() @MaxLength(60) size?: string;
  @IsOptional() @IsString() @MaxLength(60) color?: string;
  @IsOptional() @IsString() @MaxLength(60) finish?: string;
  @IsOptional() @IsString() @MaxLength(60) shape?: string;
  @IsOptional() @IsString() @MaxLength(20) unit?: string;

  @IsOptional() @IsString() @MaxLength(255)
  imagePath?: string;

  @IsOptional() @IsString()
  notes?: string;

  @IsOptional() @IsEnum(ActiveStatus)
  status?: ActiveStatus;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VariantVendorDto)
  vendors?: VariantVendorDto[];
}

export class VariantQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() categoryId?: string;
  @IsOptional() @IsEnum(ActiveStatus) status?: ActiveStatus;
}
