import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { MaterialsService } from './materials.service';
import { UpsertVariantDto, VariantQueryDto } from './dto/material.dto';
import { CurrentUser, AuthUser } from '../common/decorators';

@Controller('materials')
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  @Get('categories')
  categories() {
    return this.materials.categories();
  }

  @Get('list')
  materialsList() {
    return this.materials.materials();
  }

  // ---- Inventory / stock ----
  @Get('stock')
  stockList(@Query('search') search?: string) {
    return this.materials.stockList(search);
  }

  @Get('stock/movements')
  movements(@Query('variantId') variantId?: string) {
    return this.materials.movements(variantId ? Number(variantId) : undefined);
  }

  @Post('variants/:id/stock')
  adjustStock(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { type: 'IN' | 'OUT' | 'ADJUST'; quantity: number; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.materials.adjustStock(id, body, user.id);
  }

  @Get('variants')
  findAll(@Query() query: VariantQueryDto) {
    return this.materials.findAll(query);
  }

  @Get('variants/:id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.materials.findOne(id);
  }

  @Post('variants')
  create(@Body() dto: UpsertVariantDto, @CurrentUser() user: AuthUser) {
    return this.materials.create(dto, user.id);
  }

  @Put('variants/:id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertVariantDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.materials.update(id, dto, user.id);
  }

  @Delete('variants/:id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.materials.remove(id);
  }
}
