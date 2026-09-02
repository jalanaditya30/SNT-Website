(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SNTPaginatedQuery = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_PAGE_SIZE = 500;

  /* Fetch every row from a stable, ordered Supabase query. The project's API row cap may
     be lower than the requested page size, so advance by the number actually received.
     An exact count turns a short/incomplete response into an error instead of silently
     giving the matcher only part of the catalogue. */
  async function fetchAllRows(fetchPage, options = {}) {
    if (typeof fetchPage !== "function") throw new TypeError("fetchPage must be a function.");
    const pageSize = Number.isInteger(options.pageSize) && options.pageSize > 0
      ? options.pageSize : DEFAULT_PAGE_SIZE;
    const key = typeof options.key === "function" ? options.key : null;
    const label = options.label || "Supabase rows";
    const rows = [];
    const seen = new Set();
    let expectedCount = null;
    let offset = 0;

    while (true) {
      const result = await fetchPage(offset, offset + pageSize - 1);
      if (result?.error) throw result.error;
      if (!Array.isArray(result?.data)) throw new Error(`${label} returned an invalid page.`);

      if (Number.isInteger(result.count)) {
        if (expectedCount === null) expectedCount = result.count;
        else if (result.count !== expectedCount) {
          throw new Error(`${label} changed while it was loading. Reload and try again.`);
        }
      }

      for (const row of result.data) {
        if (key) {
          const value = key(row);
          if (seen.has(value)) throw new Error(`${label} returned duplicate row ${value}.`);
          seen.add(value);
        }
        rows.push(row);
      }

      if (expectedCount !== null) {
        if (rows.length === expectedCount) return rows;
        if (rows.length > expectedCount || result.data.length === 0) {
          throw new Error(`${label} loaded ${rows.length} of ${expectedCount} rows.`);
        }
      } else if (result.data.length === 0) {
        return rows;
      }

      offset += result.data.length;
    }
  }

  return { DEFAULT_PAGE_SIZE, fetchAllRows };
});
