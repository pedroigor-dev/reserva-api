const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createApplication } = require('../dist/app');
const { Database } = require('../dist/database');
const folder = mkdtempSync(join(tmpdir(), 'reserva-'));
process.env.API_KEY = 'inventory-test-secret-with-32-characters';
process.env.DATABASE_PATH = join(folder, 'test.sqlite');
let app, second, url, otherUrl;
async function request(path, body, key, origin = url, authenticate = true) {
  const headers = { 'content-type': 'application/json' };
  if (authenticate) headers['x-api-key'] = process.env.API_KEY;
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
before(async () => {
  app = await createApplication();
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
  second = await createApplication();
  await second.listen(0, '127.0.0.1');
  otherUrl = await second.getUrl();
});
after(async () => {
  await second?.close();
  await app?.close();
  rmSync(folder, { recursive: true, force: true });
});

test('autenticação e validação rejeitam chamadas indevidas', async () => {
  assert.equal(
    (await request('/products', { sku: 'INVALID', stock: 2 }, null, url, false))
      .status,
    401,
  );
  assert.equal(
    (await request('/products', { sku: 'INVALID', stock: -1 })).status,
    400,
  );
  assert.equal(
    (await request('/products', { sku: 'INVALID', stock: 1, admin: true }))
      .status,
    400,
  );
});
test('requisições concorrentes em duas instâncias não reservam acima do estoque', async () => {
  await request('/products', { sku: 'LIMITED', stock: 5 });
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      request(
        '/holds',
        { sku: 'LIMITED', quantity: 1, ttlSeconds: 300 },
        `limited-key-${index}`,
        index % 2 ? otherUrl : url,
      ),
    ),
  );
  assert.equal(results.filter((x) => x.status === 201).length, 5);
  assert.equal(results.filter((x) => x.status === 409).length, 7);
  assert.equal((await request('/products/LIMITED')).body.available, 0);
});
test('repetição preserva a reserva e outra carga com a mesma chave gera conflito', async () => {
  await request('/products', { sku: 'REPLAY', stock: 10 });
  const body = { sku: 'REPLAY', quantity: 3, ttlSeconds: 300 };
  const first = await request('/holds', body, 'replay-key-1');
  const repeated = await request('/holds', body, 'replay-key-1', otherUrl);
  assert.equal(first.body.id, repeated.body.id);
  assert.equal((await request('/products/REPLAY')).body.reserved, 3);
  assert.equal(
    (await request('/holds', { ...body, quantity: 4 }, 'replay-key-1')).status,
    409,
  );
});
test('confirmação repetida baixa o estoque uma vez e bloqueia cancelamento posterior', async () => {
  await request('/products', { sku: 'CONFIRM', stock: 9 });
  const { body: hold } = await request(
    '/holds',
    { sku: 'CONFIRM', quantity: 4, ttlSeconds: 300 },
    'confirm-key-1',
  );
  await request(`/holds/${hold.id}/confirm`, {});
  await request(`/holds/${hold.id}/confirm`, {});
  assert.equal((await request('/products/CONFIRM')).body.stock, 5);
  assert.equal((await request(`/holds/${hold.id}/cancel`, {})).status, 409);
  assert.deepEqual(
    (await request(`/holds/${hold.id}/audit`)).body.map((x) => x.action),
    ['reserved', 'confirmed'],
  );
});
test('cancelamento devolve disponibilidade sem aumentar estoque total', async () => {
  await request('/products', { sku: 'CANCEL', stock: 8 });
  const { body: hold } = await request(
    '/holds',
    { sku: 'CANCEL', quantity: 6, ttlSeconds: 300 },
    'cancel-key-1',
  );
  await request(`/holds/${hold.id}/cancel`, {});
  await request(`/holds/${hold.id}/cancel`, {});
  const { body } = await request('/products/CANCEL');
  assert.equal(body.stock, 8);
  assert.equal(body.available, 8);
});
test('reserva vencida libera disponibilidade e não pode ser confirmada', async () => {
  await request('/products', { sku: 'EXPIRE', stock: 1 });
  const { body: hold } = await request(
    '/holds',
    { sku: 'EXPIRE', quantity: 1, ttlSeconds: 1 },
    'expired-key-1',
  );
  app
    .get(Database)
    .connection.prepare('UPDATE holds SET expires_at=? WHERE id=?')
    .run(Date.now() - 1, hold.id);
  assert.equal((await request('/products/EXPIRE')).body.available, 1);
  assert.equal((await request(`/holds/${hold.id}/confirm`, {})).status, 409);
  assert.equal(
    (await request(`/holds/${hold.id}/audit`)).body.at(-1).action,
    'expired',
  );
});
test('estado permanece disponível após reiniciar a segunda instância', async () => {
  await request('/products', { sku: 'PERSIST', stock: 12 });
  await second.close();
  second = await createApplication();
  await second.listen(0, '127.0.0.1');
  otherUrl = await second.getUrl();
  assert.equal(
    (await request('/products/PERSIST', undefined, undefined, otherUrl)).body
      .stock,
    12,
  );
  assert.equal((await fetch(otherUrl + '/docs-json')).status, 200);
});
