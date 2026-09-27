const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'library.db');

function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS copies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id),
      barcode TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      copy_id INTEGER NOT NULL REFERENCES copies(id),
      member_id INTEGER NOT NULL REFERENCES members(id),
      borrowed_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      returned_at TEXT
    );

    -- The constraint that prevents double lending: a copy can have at most
    -- one ACTIVE (returned_at IS NULL) loan at a time. This is a partial
    -- unique index, enforced by SQLite itself on every INSERT, regardless
    -- of which code path performs the insert. See README for the reasoning.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_loan_per_copy
      ON loans(copy_id)
      WHERE returned_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_copies_book_id ON copies(book_id);
  `);
}

// The index the README's "before" section is measured without, and the
// "after" section is measured with. Kept as a separate step (rather than
// inside createSchema) so scripts/measure-query-plan.js can toggle it.
function addMemberLoansIndex(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_loans_member_active_borrowed
      ON loans(member_id, returned_at, borrowed_at DESC);
  `);
}

function dropMemberLoansIndex(db) {
  db.exec('DROP INDEX IF EXISTS idx_loans_member_active_borrowed;');
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function isSeeded(db) {
  return countRows(db, 'loans') >= 10000;
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

// Seeds books, copies, members, and >= 10,000 loans. A handful of copies
// are left with an active (unreturned) loan so the member-loans endpoint
// and the double-lending constraint both have real data to exercise.
function seed(db) {
  createSchema(db);
  if (isSeeded(db)) return;

  const BOOK_COUNT = 800;
  const COPIES_PER_BOOK = 3;
  const MEMBER_COUNT = 1500;
  const LOAN_COUNT = 12000;

  db.exec('BEGIN');
  try {
    const insertBook = db.prepare('INSERT INTO books (title, author) VALUES (?, ?)');
    for (let i = 1; i <= BOOK_COUNT; i++) {
      insertBook.run(`Book Title ${i}`, `Author ${((i * 7) % 200) + 1}`);
    }

    const insertCopy = db.prepare('INSERT INTO copies (book_id, barcode) VALUES (?, ?)');
    let copyCount = 0;
    for (let bookId = 1; bookId <= BOOK_COUNT; bookId++) {
      for (let c = 0; c < COPIES_PER_BOOK; c++) {
        copyCount++;
        insertCopy.run(bookId, `BC-${String(copyCount).padStart(6, '0')}`);
      }
    }

    const insertMember = db.prepare('INSERT INTO members (name) VALUES (?)');
    for (let i = 1; i <= MEMBER_COUNT; i++) {
      insertMember.run(`Member ${i}`);
    }

    const insertLoan = db.prepare(
      'INSERT INTO loans (copy_id, member_id, borrowed_at, due_at, returned_at) VALUES (?, ?, ?, ?, ?)'
    );

    // Track which copies currently have an active loan, so we never violate
    // the one-active-loan-per-copy constraint while seeding.
    const copyIsOut = new Set();
    let created = 0;
    let attempts = 0;
    const maxAttempts = LOAN_COUNT * 5;

    while (created < LOAN_COUNT && attempts < maxAttempts) {
      attempts++;
      const copyId = randomInt(copyCount) + 1;
      const memberId = randomInt(MEMBER_COUNT) + 1;

      // 15% of loans stay active (not yet returned); the rest are history.
      const staysActive = Math.random() < 0.15;
      if (staysActive && copyIsOut.has(copyId)) continue; // would violate the constraint

      const borrowedDaysAgo = randomInt(400);
      const borrowedAt = daysAgo(borrowedDaysAgo);
      const dueAt = daysFromNow(14 - borrowedDaysAgo);
      const returnedAt = staysActive
        ? null
        : daysAgo(Math.max(0, borrowedDaysAgo - randomInt(Math.min(30, borrowedDaysAgo + 1))));

      insertLoan.run(copyId, memberId, borrowedAt, dueAt, returnedAt);
      if (staysActive) copyIsOut.add(copyId);
      created++;
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = {
  DB_PATH,
  openDb,
  createSchema,
  seed,
  addMemberLoansIndex,
  dropMemberLoansIndex,
  countRows,
};
