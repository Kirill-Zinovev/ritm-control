// This route only sends SELECT queries and schema-reading PRAGMAs to D1.
export const databaseBackupPath = "/owner/database-backup";

const encoder = new TextEncoder();
const pageSize = 384;
const pageBytes = 640_000;
const identifier = (name) => '"' + name.replaceAll('"', '""') + '"';
const endStatement = (sql) => sql.trimEnd().replace(/;$/, "") + ";\n";

const privateHeaders = {
  "cache-control": "private, no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function page(message, action, status = 200) {
  const body = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Резервная копия D1</title><style>body{font:16px system-ui,sans-serif;max-width:600px;margin:12vh auto;padding:0 22px;color:#132742}' +
    'h1{font-size:28px}p{line-height:1.55}a{display:inline-block;background:#1b57d4;color:white;padding:12px 16px;border-radius:8px;text-decoration:none}</style>' +
    '<main><h1>Резервная копия D1</h1><p>' + message + '</p>' + action + '</main></html>';
  return new Response(body, { status, headers: { ...privateHeaders, "content-type": "text/html; charset=utf-8" } });
}

async function getSchema(db) {
  const { results } = await db.prepare("SELECT type, name, sql FROM sqlite_schema " +
    "WHERE (sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*') OR name = 'sqlite_sequence' " +
    "ORDER BY name, type").all();
  if (!results.some(({ type, name }) => type === "table" && name !== "sqlite_sequence")) {
    throw new Error("База не содержит таблиц приложения.");
  }
  return results;
}

async function getTables(db, schema) {
  const tables = schema.filter(({ type }) => type === "table");
  const sequenceIndex = tables.findIndex(({ name }) => name === "sqlite_sequence");
  if (sequenceIndex >= 0) tables.push(...tables.splice(sequenceIndex, 1));
  const definitions = await db.batch(tables.map(({ name }) => db.prepare("PRAGMA table_xinfo(" + identifier(name) + ")")));
  return tables.map(({ name, sql }, index) => {
    if (/\bWITHOUT\s+ROWID\b|\bCREATE\s+VIRTUAL\s+TABLE\b/i.test(sql)) {
      throw new Error("Формат таблицы не поддерживается выгрузкой.");
    }
    const columns = definitions[index].results.filter(({ hidden }) => hidden === 0).map(({ name }) => identifier(name));
    if (!columns.length || columns.some((column) => column.toLowerCase() === '"_rowid_"')) {
      throw new Error("Не удалось определить столбцы таблицы.");
    }
    return { name, sql, columns };
  });
}

async function readPage(db, table, after) {
  const relation = identifier(table.name);
  const columnRefs = table.columns.map((column) => "t." + column);
  const sizes = columnRefs.map((column) => "(coalesce(length(CAST(" + column + " AS BLOB)),0) * 2 + 32)").join(" + ");
  const values = columnRefs.map((column) => "CASE WHEN typeof(" + column + ")='text' AND instr(" + column +
    ",char(0))>0 THEN 'CAST(X''' || hex(" + column + ") || ''' AS TEXT)' ELSE quote(" + column + ") END").join(" || ',' || ");
  const cursor = after === null ? "" : " WHERE t._rowid_ > CAST(? AS INTEGER)";
  const statement = db.prepare(
    "WITH candidates AS (SELECT t._rowid_ AS rid, " + sizes + " AS bytes FROM " + relation + " t" + cursor +
    " ORDER BY t._rowid_ LIMIT " + pageSize + "), " +
    "bounded AS (SELECT rid, sum(bytes) OVER (ORDER BY rid) AS total, row_number() OVER (ORDER BY rid) AS position FROM candidates) " +
    "SELECT CAST(t._rowid_ AS TEXT) AS cursor, " + values + " AS value FROM bounded b JOIN " + relation +
    " t ON t._rowid_ = b.rid WHERE b.position = 1 OR b.total <= " + pageBytes + " ORDER BY b.rid",
  );
  const { results } = await (after === null ? statement : statement.bind(after)).all();
  return results;
}

async function* scanTable(db, table) {
  let count = 0;
  let cursor = null;
  let digest = "";
  const prefix = "INSERT INTO " + identifier(table.name) + "(_rowid_," + table.columns.join(",") + ") VALUES(";
  for (;;) {
    const rows = await readPage(db, table, cursor);
    if (!rows.length) return { count, digest };
    const block = rows.map((row) => prefix + row.cursor + "," + row.value + ");\n").join("");
    digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(digest + block))),
      (value) => value.toString(16).padStart(2, "0")).join("");
    cursor = rows.at(-1).cursor;
    count += rows.length;
    yield block;
  }
}

async function tableDigest(db, table) {
  const scanned = scanTable(db, table);
  for (;;) {
    const chunk = await scanned.next();
    if (chunk.done) return chunk.value;
  }
}

async function* sqlBackup(db, application) {
  const schema = await getSchema(db);
  const tables = await getTables(db, schema);
  const snapshot = [];
  yield "-- RITM D1 backup v1 " + application + " " + new Date().toISOString() + "\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n";
  for (const table of tables) if (table.name !== "sqlite_sequence") yield endStatement(table.sql);
  for (const table of tables) {
    if (table.name === "sqlite_sequence") yield "DELETE FROM sqlite_sequence;\n";
    snapshot.push(yield* scanTable(db, table));
  }
  // A second, ordered read detects changes while the download was assembled.
  // COMMIT and the completeness marker are written only after validation.
  for (const [index, table] of tables.entries()) {
    for (let attempt = 0; ; attempt += 1) {
      const actual = await tableDigest(db, table);
      const expected = snapshot[index];
      if (actual.count === expected.count && actual.digest === expected.digest) break;
      if (attempt === 2) throw new Error("Данные изменились во время выгрузки. Повторите скачивание.");
      // Only the downloaded SQL is updated. D1 is queried in read-only mode.
      yield "DELETE FROM " + identifier(table.name) + ";\n";
      snapshot[index] = yield* scanTable(db, table);
    }
    yield "-- Проверена таблица " + identifier(table.name).replace(/[\r\n]/g, " ") + "\n";
  }
  if (JSON.stringify(await getSchema(db)) !== JSON.stringify(schema)) {
    throw new Error("Схема изменилась во время выгрузки.");
  }
  // Views are created before triggers, which can target a view.
  for (const type of ["index", "view", "trigger"]) {
    for (const item of schema) if (item.type === type) yield endStatement(item.sql);
  }
  yield "COMMIT;\n-- RITM D1 backup complete " +
    JSON.stringify({ application, tables: tables.map(({ name }, index) => [name, snapshot[index].count]) }) + "\n";
}

export async function databaseBackup(request, db, application, owner) {
  if (!["GET", "HEAD"].includes(request.method)) {
    return new Response(null, { status: 405, headers: { ...privateHeaders, allow: "GET, HEAD" } });
  }
  if (!owner) {
    const signIn = request.headers.get("oai-authenticated-user-id") ? "" :
      '<a href="/signin-with-chatgpt?return_to=%2Fowner%2Fdatabase-backup" target="_top">Войти через ChatGPT</a>';
    return page("Выгрузка доступна владельцу сайта.", signIn, 403);
  }
  if (!db) return page("База D1 недоступна. Попробуйте позже.", "", 503);
  if (request.method === "HEAD") return new Response(null, { status: 204, headers: privateHeaders });

  const download = new URL(request.url).searchParams.get("download") === "sql";
  if (!download) return page("Скачайте SQL со всеми таблицами базы. Сохраняйте файл в закрытой папке.",
    '<a href="?download=sql">Скачать SQL</a>');
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return page("Откройте выгрузку со страницы резервного копирования.", "", 403);
  }
  const filename = application + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".sql";
  const iterator = sqlBackup(db, application);
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await iterator.next();
        if (chunk.done) controller.close();
        else controller.enqueue(encoder.encode(chunk.value));
      } catch (error) {
        console.error("D1 export failed", application, error.name);
        controller.error(new Error("Выгрузка не завершена."));
      }
    },
    async cancel() { await iterator.return(); },
  });
  return new Response(body, { headers: {
    ...privateHeaders, "content-type": "application/sql; charset=utf-8",
    "content-disposition": 'attachment; filename="' + filename + '"',
  } });
}
