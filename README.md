# Library loans

A small library system: books, copies of a book, members, and loans —
built on Node's built-in `node:sqlite` module, so there are no external
dependencies to install. Requires **Node.js 22+** (that's when
`node:sqlite` shipped).

## Schema

```
books    (id, title, author)
copies   (id, book_id -> books.id, barcode)
members  (id, name)
loans    (id, copy_id -> copies.id, member_id -> members.id,
          borrowed_at, due_at, returned_at)
```

`copies.book_id` and `loans.copy_id` / `loans.member_id` are all foreign
keys, enforced with `PRAGMA foreign_keys = ON`.

## Seed data

`node db.js` (or just starting the server) seeds, if the database is
empty:

- 800 books
- 2,400 copies (3 per book)
- 1,500 members
- **12,000 loans**, ~15% of which are left active (not yet returned) so
  there's real data to query and real data to test the double-lending
  constraint against

## The endpoint

`GET /members/:id/loans` — the books a member currently has checked out,
most recently borrowed first, with title and due date:

```json
[
  { "title": "Book Title 214", "dueDate": "2026-10-04T12:00:00.000Z" },
  { "title": "Book Title 87",  "dueDate": "2026-09-30T12:00:00.000Z" }
]
```

```sql
SELECT b.title AS title, l.due_at AS dueDate
FROM loans l
JOIN copies c ON c.id = l.copy_id
JOIN books b ON b.id = c.book_id
WHERE l.member_id = ? AND l.returned_at IS NULL
ORDER BY l.borrowed_at DESC
```

## Query plan: before and after the index

Captured by running `node scripts/measure-query-plan.js` against the full
12,000-row seed (see that file for exactly how — it builds a throwaway DB
so it never touches the real one).

**Before** any index on `loans(member_id, ...)` existed, SQLite fell back
to scanning the loans table via the *other* index it happened to have
(the double-lending constraint's index) and needed a separate sort step:

```
SCAN l USING INDEX uq_one_active_loan_per_copy
SEARCH c USING INTEGER PRIMARY KEY (rowid=?)
SEARCH b USING INTEGER PRIMARY KEY (rowid=?)
USE TEMP B-TREE FOR ORDER BY
```
Average: **0.283 ms** per call.

**After** adding:

```sql
CREATE INDEX idx_loans_member_active_borrowed
  ON loans(member_id, returned_at, borrowed_at DESC);
```

the query plan changes to a direct index search, and — because the index
is already in `borrowed_at DESC` order — the sort step disappears too:

```
SEARCH l USING INDEX idx_loans_member_active_borrowed (member_id=? AND returned_at=?)
SEARCH c USING INTEGER PRIMARY KEY (rowid=?)
SEARCH b USING INTEGER PRIMARY KEY (rowid=?)
```
Average: **0.005 ms** per call.

The running service (`server.js`) always creates this index on startup —
it's applied unconditionally, not something you need to add by hand.

## How double lending is prevented

A copy that's already on loan must not be lent again. That's enforced as
a **partial unique index**, not application-level logic:

```sql
CREATE UNIQUE INDEX uq_one_active_loan_per_copy
  ON loans(copy_id)
  WHERE returned_at IS NULL;
```

This says: across all rows in `loans` where `returned_at IS NULL` (i.e.
still active), `copy_id` must be unique. SQLite enforces this on every
`INSERT`, no matter what code path performs it — the app's own insert,
a future script, a manual `INSERT` run directly against the database, an
admin tool that doesn't know about this app's validation rules, all of
them get rejected the same way.

I chose a constraint over a transaction-and-check pattern (`BEGIN;
SELECT ... FOR UPDATE-equivalent; INSERT; COMMIT;`) because SQLite's
locking model makes a partial unique index simpler and just as airtight
for this shape of problem: it needs no explicit locking, it can't be
skipped by a bug in the check, and it costs one index rather than a
read-then-write round trip. `server.js` still wraps the check in a
try/catch so a rejected insert becomes a clean `409` instead of a raw
database error reaching the caller.

`test/acceptance.test.js` proves this isn't just app-level: it inserts
directly against the database, bypassing `server.js` entirely, and
confirms SQLite itself rejects the second active loan.

## Running it

```bash
node server.js
# Library loans service listening on port 3000
```

## Automated acceptance check

```bash
node test/acceptance.test.js
```

Builds its own temporary database (never touches `library.db`) and checks
every line in the brief's "A reviewer checks" list: the four related
tables with foreign keys, 10,000+ seeded rows, the list endpoint's
response time, and the double-lending constraint — including a direct
database-level bypass of the app to prove the constraint isn't just
application code.

## API reference

| Method | Path                    | Success          | Notes                              |
|--------|-------------------------|-------------------|-------------------------------------|
| GET    | `/members/:id/loans`    | `200 OK`          | current loans, most recent first    |
| POST   | `/loans`                | `201 Created`     | `409` if the copy is already out    |
| POST   | `/loans/:id/return`     | `200 OK`          | `404` if no active loan with that id|
