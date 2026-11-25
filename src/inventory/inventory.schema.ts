export const INVENTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  stock INTEGER NOT NULL CHECK(stock >= 0)
);

CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES products(sku),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  state TEXT NOT NULL CHECK(state IN ('active','confirmed','cancelled','expired')),
  expires_at INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS holds_availability ON holds(sku,state,expires_at);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  hold_id TEXT NOT NULL REFERENCES holds(id),
  action TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;
