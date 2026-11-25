const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = 'http://127.0.0.1:' + process.env.PORT;
async function call(path, body, headers = {}) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.API_KEY ?? '',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(JSON.stringify({ status: response.status, result }));
  return result;
}
async function main() {
  const sku = 'DEMO-' + crypto.randomUUID();
  await call('/products', { sku, stock: 10 });
  const key = crypto.randomUUID();
  const input = { sku, quantity: 3, ttlSeconds: 300 };
  const hold = await call('/holds', input, { 'Idempotency-Key': key });
  const repeated = await call('/holds', input, { 'Idempotency-Key': key });
  assert.equal(hold.id, repeated.id);
  await call('/holds/' + hold.id + '/confirm', {});
  const stock = await call('/products/' + sku);
  assert.equal(stock.available, 7);
  console.log(
    JSON.stringify(
      {
        hold,
        afterConfirmation: stock,
        audit: await call('/holds/' + hold.id + '/audit'),
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
