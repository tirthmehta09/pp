import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ProcessesService } from './processes.service';

class CreateServiceDto {
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(40) appliesTo?: string;
}

@Controller('processes')
export class ProcessesController {
  constructor(private readonly processes: ProcessesService) {}

  @Get()
  findAll() {
    return this.processes.findAll();
  }

  // Add a new service to the shared services master (used by the item form).
  @Post('services')
  createService(@Body() body: CreateServiceDto) {
    return this.processes.createService(body);
  }
}
