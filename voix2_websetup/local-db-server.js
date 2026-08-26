'use strict';

// Local SQLite-backed replacement for the Supabase REST endpoints
// menu-importer and supabase-ordering used to call. Not a generic
// PostgREST clone — it only implements the exact request shapes those two
// skills already send (see templates/skills/menu-importer/SKILL.md and
// templates/skills/supabase-ordering/SKILL.md), so their steps/logic
// didn't need to change, only the base URL and the removal of the
// apikey/Authorization headers Supabase required.
//
// No external dependency: uses node:sqlite (bundled with Node, confirmed
// working without --experimental-sqlite — just an ExperimentalWarning —
// on this dev environment's Node v24.14.1 via
// `node -e "require('node:sqlite')"`. Not yet confirmed on the actual
// OrangePi's installed Node version the way other paths in this repo are
// flagged as unconfirmed — check `node --version` on the box before
// relying on this).
//
// Bound to 127.0.0.1 only, deliberately: unlike piper-wrapper.js and
// kokoro_server.py, this has no auth at all, so it must never be reachable
// from the LAN — only from processes on this same machine (the agent
// calling it via exec/curl).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.LOCAL_DB_PORT || 5433;
const DATA_DIR = process.env.LOCAL_DB_DATA_DIR || path.join(os.homedir(), 'esp', 'data');
const DB_PATH = path.join(DATA_DIR, 'voix.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

// Schema matches the Supabase tables exactly — the skills' logic
// (price_adjustment option groups, the table_number requirement) already
// assumes this shape.
db.exec(`
  create table if not exists menu_items (
    id integer primary key autoincrement,
    name text not null,
    price real,
    description text,
    category text,
    options text,
    available integer default 1
  );

  create table if not exists orders (
    id integer primary key autoincrement,
    items text not null,
    total real,
    table_number text,
    created_at text default (datetime('now'))
  );
`);

const selectAllMenuItemsStmt = db.prepare('select * from menu_items');
const selectAvailableMenuItemsStmt = db.prepare('select * from menu_items where available = 1');
const deleteAllMenuItemsStmt = db.prepare('delete from menu_items');
// RETURNING (SQLite 3.35+, bundled by node:sqlite) hands back the inserted
// row directly instead of a separate re-query.
const insertMenuItemStmt = db.prepare(`
  insert into menu_items (name, price, description, category, options, available)
  values (?, ?, ?, ?, ?, ?)
  returning *
`);
const insertOrderStmt = db.prepare(`
  insert into orders (items, total, table_number)
  values (?, ?, ?)
  returning *
`);

// jsonb columns come back from Supabase's REST API already parsed, and
// `available` comes back as a real boolean — match that shape here so
// menu-importer/supabase-ordering's parsing logic (unchanged) still works.
function serializeMenuItem(row){
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    description: row.description,
    category: row.category,
    options: row.options == null ? null : JSON.parse(row.options),
    available: !!row.available,
  };
}

function serializeOrder(row){
  return {
    id: row.id,
    items: JSON.parse(row.items),
    total: row.total,
    table_number: row.table_number,
    created_at: row.created_at,
  };
}

function insertMenuItems(items){
  const inserted = [];
  db.exec('BEGIN');
  try {
    for (const item of items){
      const row = insertMenuItemStmt.get(
        item.name,
        item.price == null ? null : item.price,
        item.description == null ? null : item.description,
        item.category == null ? null : item.category,
        item.options == null ? null : JSON.stringify(item.options),
        item.available === false ? 0 : 1
      );
      inserted.push(row);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return inserted.map(serializeMenuItem);
}

function insertOrder(order){
  const row = insertOrderStmt.get(
    JSON.stringify(order.items == null ? [] : order.items),
    order.total == null ? null : order.total,
    order.table_number == null ? null : String(order.table_number)
  );
  return serializeOrder(row);
}

function readJsonBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad request URL');
  }

  try {
    if (url.pathname === '/menu_items' && req.method === 'GET'){
      // menu-importer's own confirmation GET (step 8) omits
      // available=eq.true on purpose, to see every row it just wrote
      // (including any marked unavailable) — so only filter when that
      // param is actually present, the same way PostgREST would.
      const rows = url.searchParams.get('available') === 'eq.true'
        ? selectAvailableMenuItemsStmt.all()
        : selectAllMenuItemsStmt.all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(rows.map(serializeMenuItem)));
    }

    if (url.pathname === '/menu_items' && req.method === 'DELETE'){
      deleteAllMenuItemsStmt.run();
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname === '/menu_items' && req.method === 'POST'){
      const body = await readJsonBody(req);
      if (!Array.isArray(body)){
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Expected a JSON array of menu items');
      }
      const inserted = insertMenuItems(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(inserted));
    }

    if (url.pathname === '/orders' && req.method === 'POST'){
      const body = await readJsonBody(req);
      const inserted = insertOrder(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(inserted));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(String(e.message || e).slice(0, 500));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`local-db-server listening on http://127.0.0.1:${PORT} (loopback only), db=${DB_PATH}`);
});
