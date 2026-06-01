/**
 * SELECT-only SQL guard + :placeholder binder for the Metrics module.
 *
 * Two responsibilities:
 *   1. Reject any SQL that does anything other than read (no INSERT/UPDATE/
 *      DELETE/DDL/multi-statement/etc.)
 *   2. Replace `:since`, `:until`, `:bucket` (and any other user-named
 *      placeholders) with positional `?` and return matching binds.
 *
 * Both run before the SQL reaches mysql2. The mysql2 user is also expected
 * to be read-only (defense in depth) but we never rely on that alone.
 */

const MAX_SQL_LEN = 10_000;

// Keywords that imply a write or out-of-scope side effect. Checked
// case-insensitively against tokens outside of string/identifier literals.
const FORBIDDEN_KEYWORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "REPLACE",
  "DROP", "ALTER", "CREATE", "TRUNCATE", "RENAME",
  "GRANT", "REVOKE",
  "CALL", "LOAD", "HANDLER", "USE", "SET",
  "ATTACH", "DETACH", "EXEC", "EXECUTE", "PREPARE", "DEALLOCATE",
  "LOCK", "UNLOCK",
  "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "START",
  "CHANGE",
]);

// Allowed starting keywords for a saved metric query.
const ALLOWED_LEADERS = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "EXPLAIN"]);

export type GuardResult =
  | { ok: true; cleaned: string }
  | { ok: false; reason: string };

/**
 * Strip line and block comments. Returns the cleaned SQL.
 * Honestly counts double-dash line comments and slash-star blocks.
 */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const c2 = sql[i + 1];
    // Skip line comment "--" outside any string
    if (c === "-" && c2 === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    // Skip block comment "/* ... */"
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Preserve string literals verbatim so semicolons inside them aren't
    // mistaken for statement boundaries.
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && sql[i + 1]) {
          out += sql[i] + sql[i + 1];
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Walk the (comment-free) SQL outside of strings; yield every keyword-like
 * token in uppercase. Used to detect forbidden keywords without false positives
 * from column names like `created_at` or string contents.
 */
function* tokenize(sql: string): Generator<string> {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    // Skip strings/identifiers — they were preserved by stripComments
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && sql[i + 1]) { i += 2; continue; }
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      yield sql.slice(i, j).toUpperCase();
      i = j;
      continue;
    }
    i++;
  }
}

/**
 * Sentinel: any unquoted `;` followed by anything other than whitespace means
 * multiple statements. A trailing `;` is fine.
 */
function hasMultipleStatements(sql: string): boolean {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && sql[i + 1]) { i += 2; continue; }
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === ";") {
      // Skip trailing whitespace; if anything follows, it's a second statement.
      let j = i + 1;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      if (j < sql.length) return true;
    }
    i++;
  }
  return false;
}

export function guardSelectOnly(input: string): GuardResult {
  if (typeof input !== "string") return { ok: false, reason: "SQL must be a string." };
  const sql = input.trim();
  if (!sql) return { ok: false, reason: "SQL is empty." };
  if (sql.length > MAX_SQL_LEN) return { ok: false, reason: `SQL too long (max ${MAX_SQL_LEN} chars).` };

  const cleaned = stripComments(sql).trim();
  if (!cleaned) return { ok: false, reason: "SQL is empty after stripping comments." };
  if (hasMultipleStatements(cleaned)) return { ok: false, reason: "Multiple statements are not allowed." };

  // First keyword must be a read.
  const tokens = Array.from(tokenize(cleaned));
  const first = tokens[0];
  if (!first || !ALLOWED_LEADERS.has(first)) {
    return { ok: false, reason: `Only ${[...ALLOWED_LEADERS].join(" / ")} statements are allowed. Got: ${first || "<none>"}.` };
  }

  for (const tok of tokens) {
    if (FORBIDDEN_KEYWORDS.has(tok)) {
      return { ok: false, reason: `Forbidden keyword in query: ${tok}.` };
    }
  }

  return { ok: true, cleaned };
}

/**
 * Replace `:since`, `:until`, `:bucket` (and any other named placeholder
 * in the `params` map) with positional `?` and return the rewritten SQL plus
 * the bind values in order. Placeholders inside string literals are NOT
 * substituted.
 *
 * Placeholders are matched as `:identifier` (alpha + alnum/underscore).
 * Anything in `params` is fair game; anything not present is left as-is so
 * the SQL engine can complain ("unknown column :foo" etc).
 */
export function bindNamedParams(
  sql: string,
  params: Record<string, unknown>,
): { sql: string; values: unknown[] } {
  let out = "";
  const values: unknown[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    // Pass through string literals untouched
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && sql[i + 1]) {
          out += sql[i] + sql[i + 1];
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    // Match :identifier (but NOT :: which is Postgres cast syntax — for MySQL
    // it's unlikely to appear, but be safe.)
    if (c === ":" && sql[i + 1] !== ":" && /[A-Za-z_]/.test(sql[i + 1] || "")) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      if (Object.prototype.hasOwnProperty.call(params, name)) {
        out += "?";
        values.push(params[name]);
        i = j;
        continue;
      }
    }
    out += c;
    i++;
  }
  return { sql: out, values };
}
