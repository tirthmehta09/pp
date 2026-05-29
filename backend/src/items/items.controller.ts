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
import { ItemsService } from './items.service';
import { UpsertItemDto, ItemQueryDto } from './dto/item.dto';
import { CurrentUser, AuthUser } from '../common/decorators';

@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get('meta')
  meta() {
    return this.items.meta();
  }

  @Get('next-design-code')
  nextDesignCode(@Query('shortName') shortName?: string) {
    return this.items.nextDesignCode(shortName);
  }

  // Maintenance: recompute cost price for every item from persisted data.
  @Post('recompute-costs')
  recomputeCosts() {
    return this.items.recomputeAllCosts();
  }

  @Post(':id/recompute-cost')
  recomputeCost(@Param('id', ParseIntPipe) id: number) {
    return this.items.recomputeItemCost(id).then((costPrice) => ({ id, costPrice }));
  }

  @Get()
  findAll(@Query() query: ItemQueryDto) {
    return this.items.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.items.findOne(id);
  }

  @Post()
  create(@Body() dto: UpsertItemDto, @CurrentUser() user: AuthUser) {
    return this.items.create(dto, user.id);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertItemDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.items.update(id, dto, user.id);
  }

  @Delete(':id/images/:imageId')
  deleteImage(
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
  ) {
    return this.items.deleteImage(id, imageId);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.items.remove(id);
  }
}
