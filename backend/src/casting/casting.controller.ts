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
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { CastingService } from './casting.service';
import { streamVendorPdf } from './casting.pdf';
import {
  BatchQueryDto,
  CreateBatchDto,
  CreateReceiptDto,
  ForwardStageDto,
  UpdateStageDto,
  ReceiptQueryDto,
} from './dto/casting.dto';
import { CurrentUser, AuthUser, Public } from '../common/decorators';

@Controller('casting')
export class CastingController {
  constructor(private readonly casting: CastingService) {}

  // ---- Batches ----
  @Get('next-batch-number')
  nextBatchNumber() {
    return this.casting.nextBatchNumber();
  }

  @Get('batches')
  listBatches(@Query() q: BatchQueryDto) {
    return this.casting.listBatches(q);
  }

  @Get('batches/:id')
  getBatch(@Param('id', ParseIntPipe) id: number) {
    return this.casting.getBatch(id);
  }

  @Get('batches/:id/vendors')
  batchVendors(@Param('id', ParseIntPipe) id: number) {
    return this.casting.batchVendors(id);
  }

  @Post('batches')
  createBatch(@Body() dto: CreateBatchDto, @CurrentUser() user: AuthUser) {
    return this.casting.createBatch(dto, user.id);
  }

  @Put('batches/:id')
  updateBatch(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateBatchDto) {
    return this.casting.updateBatch(id, dto);
  }

  @Delete('batches/:id')
  removeBatch(@Param('id', ParseIntPipe) id: number) {
    return this.casting.removeBatch(id);
  }

  // Forward received pieces of a stage to the next process.
  @Post('batch-items/:id/forward')
  forwardStage(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ForwardStageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.casting.forwardStage(id, dto, user.id);
  }

  // Edit an existing stage (vendor/qty/weight/rate/colour/remarks).
  @Put('batch-items/:id')
  updateStage(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateStageDto) {
    return this.casting.updateStage(id, dto);
  }

  // Per-vendor PDF. Public so it can open in a new tab / be shared; the token
  // is still passed as a query param by the client for traceability.
  @Public()
  @Get('batches/:id/pdf/:vendorId')
  async vendorPdf(
    @Param('id', ParseIntPipe) id: number,
    @Param('vendorId', ParseIntPipe) vendorId: number,
    @Query('processId') processId: string | undefined,
    @Res() res: Response,
  ) {
    const data = await this.casting.vendorPdfData(id, vendorId, processId ? Number(processId) : undefined);
    streamVendorPdf(res, data);
  }

  // Per-MOVEMENT issue slip — one slip for a single stage (each forward/issue).
  @Public()
  @Get('stages/:id/pdf')
  async stagePdf(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const data = await this.casting.stagePdfData(id);
    streamVendorPdf(res, data);
  }

  // Per-receipt PDF (receive slip).
  @Public()
  @Get('receipts/:id/pdf')
  async receiptPdf(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const data = await this.casting.receiptPdfData(id);
    streamVendorPdf(res, data);
  }

  // ---- Receipts ----
  @Get('receipts')
  listReceipts(@Query() q: ReceiptQueryDto) {
    return this.casting.listReceipts(q);
  }

  // Produced-goods inventory (idle/finished pieces grouped by design + last process).
  @Get('produced')
  producedGoods(@Query('itemId') itemId?: string) {
    return this.casting.producedGoods(itemId ? Number(itemId) : undefined);
  }

  // Continue idle in-process pieces straight to their next process (settle stock).
  @Post('settle')
  settle(
    @Body() body: { stageIds: number[]; nextProcessId: number; color?: string; vendorId?: number; maxQty?: number; targetBatchId?: number },
    @CurrentUser() user: AuthUser,
  ) {
    return this.casting.settleInProcess(body, user.id);
  }

  // Record a planned forward on an AT-VENDOR stage — applied automatically when
  // the stage is later received via Receive Goods (auto-forwards into the
  // planned target batch). Pass null fields to clear an existing plan.
  @Post('stages/:id/plan-forward')
  planForward(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { nextProcessId: number | null; vendorId?: number | null; color?: string | null; targetBatchId?: number | null },
  ) {
    return this.casting.planForward(id, body);
  }

  // Preview the editable material-issue table the Forward dialog shows when
  // the target step is Sticking. Aggregates BOM × qty across colour splits and
  // returns the default issue qty (per variant) plus current stock for context.
  @Post('preview-sticking-issue')
  previewStickingIssue(
    @Body()
    body: {
      itemId: number;
      splits: { color?: string | null; quantity: number }[];
      bufferPercent?: number;
    },
  ) {
    return this.casting.previewStickingIssue(
      body.itemId,
      body.splits ?? [],
      body.bufferPercent ?? 0,
    );
  }

  @Get('batches/:id/pending/:vendorId')
  pending(
    @Param('id', ParseIntPipe) id: number,
    @Param('vendorId', ParseIntPipe) vendorId: number,
  ) {
    return this.casting.pendingForVendor(id, vendorId);
  }

  @Post('receipts')
  createReceipt(@Body() dto: CreateReceiptDto, @CurrentUser() user: AuthUser) {
    return this.casting.createReceipt(dto, user.id);
  }

  @Delete('receipts/:id')
  deleteReceipt(@Param('id', ParseIntPipe) id: number) {
    return this.casting.deleteReceipt(id);
  }

  // ---- Short-close a single order line ----
  @Post('batch-items/:id/close')
  closeItem(@Param('id', ParseIntPipe) id: number, @Body() body: { reason?: string }) {
    return this.casting.closeBatchItem(id, body?.reason);
  }

  // ---- Short-close the WHOLE batch (every still-open stage). ----
  @Post('batches/:id/close')
  closeBatch(@Param('id', ParseIntPipe) id: number, @Body() body: { reason?: string }) {
    return this.casting.closeBatch(id, body?.reason);
  }

  // ---- Reopen a short-closed batch (clears the batch-level mark). ----
  @Post('batches/:id/reopen')
  reopenBatch(@Param('id', ParseIntPipe) id: number) {
    return this.casting.reopenBatch(id);
  }

  @Post('batch-items/:id/reopen')
  reopenItem(@Param('id', ParseIntPipe) id: number) {
    return this.casting.reopenBatchItem(id);
  }

  // ---- Vendor ledger (Balances & Bills) ----
  @Get('vendor-ledger/:vendorId')
  vendorLedger(
    @Param('vendorId', ParseIntPipe) vendorId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.casting.vendorLedger(vendorId, from, to);
  }
}
