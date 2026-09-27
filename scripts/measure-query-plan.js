// Builds a fresh, fully-seeded database, then measures the member-loans
// query's EXPLAIN QUERY PLAN and response time before the index exists and
// after it's added. Output is pasted into README.md as evidence.
//
// Run with: node scripts/measure-query-plan.js

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createSchema, seed, addMemberLoansIndex, dropMemberLoansIndex, countRows } = require('../db');

const TMP_DB = path.join(__dirname, '..', 'measure.tmp.db');
if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);

process.env.DB_PATH = TMP_DB;
const db = new DatabaseSync(TMP_DB);
createSchema(db);
seed(db);
dropMemberLoansIndex(db); // start from the "before" state

const QUERY = `
  SELECT b.title AS title, l.due_at AS dueDate
  FROM loans l
  JOIN copies c ON c.id = l.copy_id
  JOIN books b ON b.id = c.book_id
  WHERE l.member_id = ? AND l.returned_at IS NULL
  ORDER BY l.borrowed_at DESC
`;

function explain(db) {
  return db.prepare(`EXPLAIN QUERY PLAN ${QUERY}`).all(1);
}

function timeQuery(db, iterations = 200) {
  const stmt = db.prepare(QUERY);
  const memberCount = db.prepare('SELECT COUNT(*) AS n FROM members').get().n;
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    const memberId = (i % memberCount) + 1;
    stmt.all(memberId);
  }
  const end = process.hrtime.bigint();
  const totalMs = Number(end - start) / 1e6;
  return totalMs / iterations;
}

console.log(`Seeded rows -- books: ${countRows(db, 'books')}, copies: ${countRows(db, 'copies')}, members: ${countRows(db, 'members')}, loans: ${countRows(db, 'loans')}\n`);

console.log('--- BEFORE index ---');
console.log('EXPLAIN QUERY PLAN:');
console.log(JSON.stringify(explain(db), null, 2));
const beforeMs = timeQuery(db);
console.log(`Average time per call: ${beforeMs.toFixed(3)} ms\n`);

addMemberLoansIndex(db);

console.log('--- AFTER index (idx_loans_member_active_borrowed) ---');
console.log('EXPLAIN QUERY PLAN:');
console.log(JSON.stringify(explain(db), null, 2));
const afterMs = timeQuery(db);
console.log(`Average time per call: ${afterMs.toFixed(3)} ms\n`);

fs.unlinkSync(TMP_DB);
