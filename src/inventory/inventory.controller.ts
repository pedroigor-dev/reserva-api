import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../security/api-key.guard';
import { CreateHold, CreateProduct } from './inventory.dto';
import { Inventory } from './inventory.service';

@ApiTags('Estoque e reservas')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@Controller()
export class InventoryController {
  constructor(private readonly inventory: Inventory) {}

  @Post('products')
  create(
    @Body()
    input: CreateProduct,
  ) {
    return this.inventory.product(input);
  }

  @Get('products/:sku')
  stock(
    @Param('sku')
    sku: string,
  ) {
    return this.inventory.availability(sku);
  }

  @Post('holds')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  hold(
    @Body()
    input: CreateHold,
    @Headers('idempotency-key')
    key: string | undefined,
  ) {
    return this.inventory.reserve(input, key);
  }

  @Post('holds/:id/confirm')
  confirm(
    @Param('id')
    id: string,
  ) {
    return this.inventory.change(id, 'confirmed');
  }

  @Post('holds/:id/cancel')
  cancel(
    @Param('id')
    id: string,
  ) {
    return this.inventory.change(id, 'cancelled');
  }

  @Get('holds/:id/audit')
  audit(
    @Param('id')
    id: string,
  ) {
    return this.inventory.history(id);
  }
}
