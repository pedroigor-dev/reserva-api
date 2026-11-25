import { INVENTORY_SCHEMA } from './inventory.schema';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Database } from '../database/database.service';
import { CreateHold, CreateProduct } from './inventory.dto';
import { Hold } from './inventory.types';

@Injectable()
export class Inventory {
  constructor(private readonly db: Database) {
    db.connection.exec(INVENTORY_SCHEMA);
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
      ) {
        throw new ConflictException('SKU já cadastrado');
      }
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
      if (!product) {
        throw new NotFoundException('SKU inexistente');
      }
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
    if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
      throw new BadRequestException(
        'Idempotency-Key deve ter 8 a 100 caracteres alfanuméricos, hífen ou sublinhado',
      );
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([input.sku, input.quantity, input.ttlSeconds]))
      .digest('hex');
    return this.db.transaction(() => {
      this.expire();
      const previous = this.db.connection
        .prepare('SELECT * FROM holds WHERE key=?')
        .get(key) as Hold | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          throw new ConflictException('Chave já utilizada com outro conteúdo');
        }
        return this.publicHold(previous);
      }
      const product = this.db.connection
        .prepare('SELECT stock FROM products WHERE sku=?')
        .get(input.sku);
      if (!product) {
        throw new NotFoundException('SKU inexistente');
      }
      const reserved = this.db.connection
        .prepare(
          "SELECT COALESCE(SUM(quantity),0) AS quantity FROM holds WHERE sku=? AND state='active'",
        )
        .get(input.sku)!;
      if (Number(product.stock) - Number(reserved.quantity) < input.quantity) {
        throw new ConflictException('Estoque insuficiente');
      }
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
      if (!hold) {
        throw new NotFoundException('Reserva inexistente');
      }
      if (hold.state === target) {
        return this.publicHold(hold);
      }
      if (hold.state !== 'active') {
        throw new ConflictException(`Reserva ${hold.state}`);
      }
      if (target === 'confirmed') {
        this.db.connection
          .prepare('UPDATE products SET stock=stock-? WHERE sku=?')
          .run(hold.quantity, hold.sku);
      }
      this.db.connection
        .prepare('UPDATE holds SET state=? WHERE id=?')
        .run(target, id);
      this.audit(id, target);
      return this.publicHold({ ...hold, state: target });
    });
  }

  history(id: string) {
    if (
      !this.db.connection.prepare('SELECT id FROM holds WHERE id=?').get(id)
    ) {
      throw new NotFoundException('Reserva inexistente');
    }
    return this.db.connection
      .prepare('SELECT action,at FROM audit WHERE hold_id=? ORDER BY id')
      .all(id);
  }
}
