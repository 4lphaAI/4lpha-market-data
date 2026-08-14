/**
 * A stand-in for `pg.Pool` that knows the schema it was handed.
 *
 * Not a test file: the runner only globs `*.test.ts`.
 *
 * A fake that merely records SQL and hands back canned rows would have accepted
 * the write that broke production — 2,592,000,000 milliseconds into a column
 * declared `int` — because it would have had no idea what the column was. So
 * this one reads the `create table` statement the store actually ships, keeps
 * the declared column types, and checks every bound parameter against them,
 * rejecting with the same message Postgres used.
 *
 * It also answers the way `pg` answers, which is the other half of the point:
 * `bigint` comes back as a **string**, `timestamptz` as a `Date`, `jsonb`
 * already parsed. Those conversions exist nowhere else in the test suite,
 * because `MemoryStore` stores the values it was given.
 *
 * It is deliberately not a SQL engine. It understands exactly the five
 * statement shapes `PostgresStore` issues, and throws on anything else rather
 * than quietly doing nothing.
 */

import type { SqlClient } from "../src/core/store.js";

type ColumnType = "int" | "bigint" | "text" | "jsonb" | "timestamptz";

interface Table {
  columns: Map<string, ColumnType>;
  primaryKey: string;
  rows: Map<string, Record<string, unknown>>;
}

const INT_MAX = 2_147_483_647;
const BIGINT_MAX = 9_223_372_036_854_775_807n;

export interface FakePgOptions {
  /** Returns an error to throw for a matching statement. Tests failure paths. */
  failOn?: ((sql: string) => Error | null) | undefined;
}

export class FakePg implements SqlClient {
  /** Every statement received, normalized, in order. */
  readonly queries: string[] = [];
  #tables = new Map<string, Table>();
  #ended = false;
  readonly #failOn: FakePgOptions["failOn"];

  constructor(options: FakePgOptions = {}) {
    this.#failOn = options.failOn;
  }

  /** True once `end()` has been called, so a leaked pool is visible. */
  get ended(): boolean {
    return this.#ended;
  }

  /** Column types currently declared for a table, after any migration. */
  columnType(table: string, column: string): ColumnType | undefined {
    return this.#tables.get(table)?.columns.get(column);
  }

  rowCount(table: string): number {
    return this.#tables.get(table)?.rows.size ?? 0;
  }

  async end(): Promise<void> {
    this.#ended = true;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const text = sql.replace(/\s+/gu, " ").trim();
    this.queries.push(text);

    const failure = this.#failOn?.(text);
    if (failure !== null && failure !== undefined) throw failure;

    const lowered = text.toLowerCase();
    if (lowered.startsWith("create table")) return { rows: this.#createTable(text) as T[] };
    if (lowered.startsWith("alter table")) return { rows: this.#alterTable(text) as T[] };
    if (lowered.startsWith("insert into")) return { rows: this.#insert(text, params) as T[] };
    if (lowered.startsWith("select")) return { rows: this.#select(text, params) as T[] };
    throw new Error(`fake-pg: unsupported statement: ${text.slice(0, 60)}`);
  }

  // ─── DDL ───────────────────────────────────────────────────────────────────

  #createTable(sql: string): never[] {
    const name = /create table (?:if not exists )?(\w+)/iu.exec(sql)?.[1];
    const body = sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")"));
    if (name === undefined) throw new Error("fake-pg: unparseable create table");

    // `if not exists` means exactly that: a second call must not reset the
    // table, which is what makes the separate migration statement necessary.
    if (this.#tables.has(name)) return [];

    const columns = new Map<string, ColumnType>();
    let primaryKey = "";
    for (const entry of splitTopLevel(body)) {
      const [column, type] = entry.trim().split(/\s+/u);
      if (column === undefined || type === undefined) continue;
      columns.set(column, normalizeType(type));
      if (/primary key/iu.test(entry)) primaryKey = column;
    }
    this.#tables.set(name, { columns, primaryKey, rows: new Map() });
    return [];
  }

  #alterTable(sql: string): never[] {
    const name = /alter table (\w+)/iu.exec(sql)?.[1];
    const table = name === undefined ? undefined : this.#tables.get(name);
    if (table === undefined) throw new Error(`fake-pg: relation "${String(name)}" does not exist`);

    for (const [, column, type] of sql.matchAll(/alter column (\w+) type (\w+)/giu)) {
      if (column === undefined || type === undefined) continue;
      if (!table.columns.has(column)) {
        throw new Error(`fake-pg: column "${column}" does not exist`);
      }
      table.columns.set(column, normalizeType(type));
    }
    return [];
  }

  // ─── DML ───────────────────────────────────────────────────────────────────

  #insert(sql: string, params: unknown[]): never[] {
    const name = /insert into (\w+)/iu.exec(sql)?.[1];
    const table = name === undefined ? undefined : this.#tables.get(name);
    if (table === undefined) throw new Error(`fake-pg: relation "${String(name)}" does not exist`);

    const columnList = /\(([^)]*)\)\s*values/iu.exec(sql)?.[1];
    const valueList = /values\s*\(([^)]*\)?[^)]*)\)/iu.exec(sql)?.[1];
    if (columnList === undefined || valueList === undefined) {
      throw new Error("fake-pg: unparseable insert");
    }

    const columns = columnList.split(",").map((c) => c.trim());
    const values = splitTopLevel(valueList).map((v) => v.trim());

    const row: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      const expression = values[index];
      if (expression === undefined) return;

      const placeholder = /^\$(\d+)/u.exec(expression);
      if (placeholder === null) {
        // `now()` and friends: not a bound value, so nothing to check.
        row[column] = new Date();
        return;
      }
      const value = params[Number(placeholder[1]) - 1] ?? null;
      const type = table.columns.get(column);
      if (type === undefined) throw new Error(`fake-pg: column "${column}" does not exist`);
      assertBindable(column, type, value);
      row[column] = value;
    });

    const key = String(row[table.primaryKey]);
    // Every insert this store issues carries `on conflict do update`, so a
    // repeat write replaces rather than raising a duplicate-key error.
    if (table.rows.has(key) && !/on conflict/iu.test(sql)) {
      throw new Error(`fake-pg: duplicate key value violates unique constraint`);
    }
    table.rows.set(key, row);
    return [];
  }

  #select(sql: string, params: unknown[]): Array<Record<string, unknown>> {
    const name = /from (\w+)/iu.exec(sql)?.[1];
    const table = name === undefined ? undefined : this.#tables.get(name);
    if (table === undefined) throw new Error(`fake-pg: relation "${String(name)}" does not exist`);

    const columnList = /select (.+?) from/iu.exec(sql)?.[1];
    const columns = (columnList ?? "").split(",").map((c) => c.trim());

    let rows = [...table.rows.values()];
    const where = /where (\w+) = \$(\d+)/iu.exec(sql);
    if (where !== null) {
      const wanted = params[Number(where[2]) - 1];
      rows = rows.filter((row) => row[where[1] ?? ""] === wanted);
    }

    const orderBy = /order by (\w+)/iu.exec(sql)?.[1];
    if (orderBy !== undefined) {
      rows = [...rows].sort((a, b) => String(a[orderBy]).localeCompare(String(b[orderBy])));
    }

    return rows.map((row) => {
      const projected: Record<string, unknown> = {};
      for (const column of columns) {
        projected[column] = render(table.columns.get(column), row[column]);
      }
      return projected;
    });
  }
}

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

function normalizeType(raw: string): ColumnType {
  const type = raw.toLowerCase();
  if (type === "int" || type === "integer") return "int";
  if (type === "bigint" || type === "int8") return "bigint";
  if (type === "jsonb") return "jsonb";
  if (type === "timestamptz") return "timestamptz";
  return "text";
}

/**
 * Rejects a value the declared column could not hold, wording it the way
 * Postgres does so a test can assert against the failure production saw.
 */
function assertBindable(column: string, type: ColumnType, value: unknown): void {
  if (value === null) return;

  switch (type) {
    case "int":
    case "bigint": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`fake-pg: invalid input syntax for type ${type} at column "${column}"`);
      }
      const limit = type === "int" ? BigInt(INT_MAX) : BIGINT_MAX;
      if (BigInt(value) > limit || BigInt(value) < -limit - 1n) {
        const named = type === "int" ? "integer" : "bigint";
        throw new Error(`value "${value}" is out of range for type ${named}`);
      }
      return;
    }
    case "timestamptz":
      if (!(value instanceof Date)) {
        throw new Error(`fake-pg: column "${column}" expects a Date`);
      }
      return;
    case "jsonb":
      if (typeof value !== "string") {
        throw new Error(`fake-pg: column "${column}" expects serialized JSON`);
      }
      JSON.parse(value);
      return;
    default:
      if (typeof value !== "string") {
        throw new Error(`fake-pg: column "${column}" expects text`);
      }
  }
}

/**
 * Returns a value the way `pg` would.
 *
 * `bigint` is the one that matters: node-postgres hands it back as a string
 * rather than risk losing precision past 2^53, which is why the store has to
 * coerce it before doing arithmetic — a conversion no other test can reach.
 */
function render(type: ColumnType | undefined, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (type === "bigint") return String(value);
  if (type === "jsonb" && typeof value === "string") return JSON.parse(value) as unknown;
  return value;
}
