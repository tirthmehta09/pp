import {
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ActiveStatus } from '@prisma/client';

export class UpsertVendorDto {
  @IsString()
  @MaxLength(150, { message: 'vendor_name must be at most 150 characters' })
  vendorName!: string;

  @IsOptional() @IsString() @MaxLength(60)
  shortName?: string;

  @IsOptional() @IsString() @MaxLength(120)
  contactPerson?: string;

  @IsOptional() @IsString() @MaxLength(20)
  mobile?: string;

  @IsOptional() @IsEmail({}, { message: 'email must be a valid email' })
  email?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsString() @MaxLength(20)
  gstNumber?: string;

  @IsOptional() @IsString() @MaxLength(15)
  panNumber?: string;

  @IsOptional() @IsString()
  notes?: string;

  @IsOptional() @IsEnum(ActiveStatus)
  status?: ActiveStatus;

  @IsOptional() @IsArray() @IsInt({ each: true })
  processIds?: number[];
}

export class VendorQueryDto {
  @IsOptional() @IsString()
  search?: string;

  @IsOptional()
  processId?: string;

  @IsOptional() @IsEnum(ActiveStatus)
  status?: ActiveStatus;
}
