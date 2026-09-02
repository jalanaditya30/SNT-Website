"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchAllRows } = require("../paginated-query.js");

function cappedSource(rows, cap, calls) {
  return async (from, to) => {
    calls.push([from, to]);
    const allowed = Math.min(to - from + 1, cap);
    return { data: rows.slice(from, from + allowed), count: rows.length, error: null };
  };
}

test("loads all 2,507 rows even when the API caps each response at 1,000", async () => {
  const source = Array.from({ length: 2507 }, (_, index) => ({ id: index + 1 }));
  const calls = [];
  const rows = await fetchAllRows(cappedSource(source, 1000, calls), {
    pageSize: 1000, key: (row) => row.id, label: "Catalogue"
  });

  assert.equal(rows.length, 2507);
  assert.deepEqual(rows.map((row) => row.id), source.map((row) => row.id));
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test("advances by the rows actually returned when the server cap is smaller", async () => {
  const source = Array.from({ length: 1554 }, (_, index) => ({ id: index + 1 }));
  const calls = [];
  const rows = await fetchAllRows(cappedSource(source, 375, calls), {
    pageSize: 500, key: (row) => row.id, label: "Catalogue"
  });

  assert.equal(rows.length, 1554);
  assert.deepEqual(calls.map(([from]) => from), [0, 375, 750, 1125, 1500]);
});

test("refuses a silently incomplete catalogue", async () => {
  await assert.rejects(
    fetchAllRows(async () => ({ data: [], count: 1554, error: null }), { label: "Catalogue" }),
    /loaded 0 of 1554 rows/
  );
});

test("refuses duplicate IDs caused by unstable pagination", async () => {
  let call = 0;
  await assert.rejects(fetchAllRows(async () => {
    call += 1;
    return call === 1
      ? { data: [{ id: 1 }, { id: 2 }], count: 3, error: null }
      : { data: [{ id: 2 }], count: 3, error: null };
  }, { pageSize: 2, key: (row) => row.id, label: "Catalogue" }), /duplicate row 2/);
});
