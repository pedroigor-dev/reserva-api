import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ApiKeyGuard } from '../security/api-key.guard';
import { InventoryController } from './inventory.controller';
import { Inventory } from './inventory.service';

@Module({
  imports: [DatabaseModule],
  controllers: [InventoryController],
  providers: [Inventory, ApiKeyGuard],
})
export class InventoryModule {}
