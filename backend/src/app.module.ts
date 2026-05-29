import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { UsersModule } from './users/users.module';
import { ProcessesModule } from './processes/processes.module';
import { VendorsModule } from './vendors/vendors.module';
import { MaterialsModule } from './materials/materials.module';
import { ItemsModule } from './items/items.module';
import { UploadsModule } from './uploads/uploads.module';
import { CastingModule } from './casting/casting.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MaterialIssuesModule } from './material-issues/material-issues.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    ProcessesModule,
    VendorsModule,
    MaterialsModule,
    ItemsModule,
    UploadsModule,
    CastingModule,
    DashboardModule,
    MaterialIssuesModule,
  ],
  providers: [
    // JWT auth is global; routes opt out with @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
