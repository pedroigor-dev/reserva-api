import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiProperty, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { Database } from './database';
import { ApiKeyGuard } from './security';

export class CreateProduct {
  @ApiProperty({ example: 'CAMISA-BAHIA-M' })
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  sku!: string;
  @ApiProperty({ example: 10 }) @IsInt() @Min(0) @Max(1000000) stock!: number;
}
export class CreateHold {
  @ApiProperty({ example: 'CAMISA-BAHIA-M' })
  @IsString()
  @MaxLength(64)
  sku!: string;
  @ApiProperty({ example: 2 }) @IsInt() @Min(1) @Max(1000000) quantity!: number;
  @ApiProperty({ example: 300, maximum: 3600 })
  @IsInt()
  @Min(1)
  @Max(3600)
  ttlSeconds!: number;
}
type Hold = {
  id: string;
  sku: string;
  quantity: number;
  state: string;
  expires_at: number;
  fingerprint: string;
  key: string;
};

@Injectable()
export class Inventory {
  constructor(private readonly db: Database) {
    db.connection.exec(`
      CREATE TABLE IF NOT EXISTS products(sku TEXT PRIMARY KEY, stock INTEGER NOT NULL CHECK(stock >= 0));
      CREATE TABLE IF NOT EXISTS holds(id TEXT PRIMARY KEY, sku TEXT NOT NULL REFERENCES products(sku), quantity INTEGER NOT NULL CHECK(quantity > 0), state TEXT NOT NULL CHECK(state IN ('active','confirmed','cancelled','expired')), expires_at INTEGER NOT NULL, key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS holds_availability ON holds(sku,state,expires_at);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, hold_id TEXT NOT NULL REFERENCES holds(id), action TEXT NOT NULL, at INTEGER NOT NULL);
    `);
  }
  private audit(id: string, action: string) {
    this.db.connection
      .prepare('INSERT INTO audit(hold_id,action,at) VALUES(?,?,?)')
      .run(id, action, Date.now());
  }
  private expire() {
    const expired = this.db.connection
      .prepare(
        "UPDATE holds SET state='expired' WHERE state='active' AND expires_at <= ? RETURNING id",
      )
      .all(Date.now());
    for (const row of expired) this.audit(String(row.id), 'expired');
  }
  product(input: CreateProduct) {
    return this.db.transaction(() => {
      if (
        this.db.connection
          .prepare('SELECT sku FROM products WHERE sku=?')
          .get(input.sku)
      )
        throw new ConflictException('SKU já cadastrado');
      this.db.connection
        .prepare('INSERT INTO products(sku,stock) VALUES(?,?)')
        .run(input.sku, input.stock);
      return input;
    });
  }
  availability(sku: string) {
    return this.db.transaction(() => {
      this.expire();
      const product = this.db.connection
        .prepare('SELECT * FROM products WHERE sku=?')
        .get(sku);
      if (!product) throw new NotFoundException('SKU inexistente');
      const reserved = this.db.connection
        .prepare(
          "SELECT COALESCE(SUM(quantity),0) AS quantity FROM holds WHERE sku=? AND state='active'",
        )
        .get(sku)!;
      return {
        sku,
        stock: Number(product.stock),
        reserved: Number(reserved.quantity),
        available: Number(product.stock) - Number(reserved.quantity),
      };
    });
  }
  reserve(input: CreateHold, key: string | undefined) {
    if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
      throw new BadRequestException(
        'Idempotency-Key deve ter 8 a 100 caracteres alfanuméricos, hífen ou sublinhado',
      );
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([input.sku, input.quantity, input.ttlSeconds]))
      .digest('hex');
    return this.db.transaction(() => {
      this.expire();
      const previous = this.db.connection
        .prepare('SELECT * FROM holds WHERE key=?')
        .get(key) as Hold | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ConflictException('Chave já utilizada com outro conteúdo');
        return this.publicHold(previous);
      }
      const product = this.db.connection
        .prepare('SELECT stock FROM products WHERE sku=?')
        .get(input.sku);
      if (!product) throw new NotFoundException('SKU inexistente');
      const reserved = this.db.connection
        .prepare(
          "SELECT COALESCE(SUM(quantity),0) AS quantity FROM holds WHERE sku=? AND state='active'",
        )
        .get(input.sku)!;
      if (Number(product.stock) - Number(reserved.quantity) < input.quantity)
        throw new ConflictException('Estoque insuficiente');
      const id = randomUUID();
      this.db.connection
        .prepare("INSERT INTO holds VALUES(?,?,?,'active',?,?,?)")
        .run(
          id,
          input.sku,
          input.quantity,
          Date.now() + input.ttlSeconds * 1000,
          key,
          fingerprint,
        );
      this.audit(id, 'reserved');
      return this.publicHold(
        this.db.connection
          .prepare('SELECT * FROM holds WHERE id=?')
          .get(id) as Hold,
      );
    });
  }
  private publicHold(row: Hold) {
    return {
      id: row.id,
      sku: row.sku,
      quantity: row.quantity,
      state: row.state,
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }
  change(id: string, target: 'confirmed' | 'cancelled') {
    return this.db.transaction(() => {
      this.expire();
      const hold = this.db.connection
        .prepare('SELECT * FROM holds WHERE id=?')
        .get(id) as Hold | undefined;
      if (!hold) throw new NotFoundException('Reserva inexistente');
      if (hold.state === target) return this.publicHold(hold);
      if (hold.state !== 'active')
        throw new ConflictException(`Reserva ${hold.state}`);
      if (target === 'confirmed')
        this.db.connection
          .prepare('UPDATE products SET stock=stock-? WHERE sku=?')
          .run(hold.quantity, hold.sku);
      this.db.connection
        .prepare('UPDATE holds SET state=? WHERE id=?')
        .run(target, id);
      this.audit(id, target);
      return this.publicHold({ ...hold, state: target });
    });
  }
  history(id: string) {
    if (!this.db.connection.prepare('SELECT id FROM holds WHERE id=?').get(id))
      throw new NotFoundException('Reserva inexistente');
    return this.db.connection
      .prepare('SELECT action,at FROM audit WHERE hold_id=? ORDER BY id')
      .all(id);
  }
}

@ApiTags('Estoque e reservas')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@Controller()
export class InventoryController {
  constructor(private readonly inventory: Inventory) {}
  @Post('products') create(@Body() input: CreateProduct) {
    return this.inventory.product(input);
  }
  @Get('products/:sku') stock(@Param('sku') sku: string) {
    return this.inventory.availability(sku);
  }
  @Post('holds') @ApiHeader({ name: 'Idempotency-Key', required: true }) hold(
    @Body() input: CreateHold,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.inventory.reserve(input, key);
  }
  @Post('holds/:id/confirm') confirm(@Param('id') id: string) {
    return this.inventory.change(id, 'confirmed');
  }
  @Post('holds/:id/cancel') cancel(@Param('id') id: string) {
    return this.inventory.change(id, 'cancelled');
  }
  @Get('holds/:id/audit') audit(@Param('id') id: string) {
    return this.inventory.history(id);
  }
}
