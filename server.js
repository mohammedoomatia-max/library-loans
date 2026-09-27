const http = require('http');
const { openDb, seed, addMemberLoansIndex } = require('./db');

const PORT = process.env.PORT || 3000;

const db = openDb();
seed(db);
addMemberLoansIndex(db); // the service always runs with the index in place

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function badRequest(res, field, message) {
  sendJSON(res, 400, { error: message, field });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req, res) {
  const raw = await readBody(req);
  if (!raw || raw.trim().length === 0) {
    badRequest(res, 'body', 'request body is required');
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    badRequest(res, 'body', 'request body must be valid JSON');
    return null;
  }
}

// The endpoint the brief cares about: for a given member, the books they
// currently have out, most recently borrowed first, with title + due date.
const memberLoansStmt = db.prepare(`
  SELECT b.title AS title, l.due_at AS dueDate
  FROM loans l
  JOIN copies c ON c.id = l.copy_id
  JOIN books b ON b.id = c.book_id
  WHERE l.member_id = ? AND l.returned_at IS NULL
  ORDER BY l.borrowed_at DESC
`);

function handleMemberLoans(req, res, memberId) {
  if (!/^\d+$/.test(memberId)) {
    return badRequest(res, 'memberId', 'memberId must be a positive integer');
  }
  const rows = memberLoansStmt.all(Number(memberId));
  return sendJSON(res, 200, rows);
}

const insertLoanStmt = db.prepare(
  'INSERT INTO loans (copy_id, member_id, borrowed_at, due_at, returned_at) VALUES (?, ?, ?, ?, NULL)'
);
const copyExistsStmt = db.prepare('SELECT id FROM copies WHERE id = ?');
const memberExistsStmt = db.prepare('SELECT id FROM members WHERE id = ?');

async function handleCreateLoan(req, res) {
  const payload = await parseJsonBody(req, res);
  if (payload === null) return;

  const { copyId, memberId, dueAt } = payload;
  if (!Number.isInteger(copyId)) return badRequest(res, 'copyId', 'copyId must be an integer');
  if (!Number.isInteger(memberId)) return badRequest(res, 'memberId', 'memberId must be an integer');
  if (typeof dueAt !== 'string' || dueAt.trim().length === 0) {
    return badRequest(res, 'dueAt', 'dueAt is required (ISO date string)');
  }
  if (!copyExistsStmt.get(copyId)) return badRequest(res, 'copyId', 'copy does not exist');
  if (!memberExistsStmt.get(memberId)) return badRequest(res, 'memberId', 'member does not exist');

  const borrowedAt = new Date().toISOString();

  // This insert is the only place a loan is created. If the copy already
  // has an active loan, the partial unique index in the schema rejects the
  // insert at the database level -- the check below is just so we can
  // return a clear, well-named 409 instead of a raw driver error.
  try {
    const info = insertLoanStmt.run(copyId, memberId, borrowedAt, dueAt);
    return sendJSON(res, 201, { id: Number(info.lastInsertRowid), copyId, memberId, borrowedAt, dueAt });
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      return sendJSON(res, 409, {
        error: 'this copy is already on loan',
        field: 'copyId',
      });
    }
    throw err;
  }
}

const returnLoanStmt = db.prepare(
  'UPDATE loans SET returned_at = ? WHERE id = ? AND returned_at IS NULL'
);

function handleReturnLoan(req, res, loanId) {
  if (!/^\d+$/.test(loanId)) return badRequest(res, 'loanId', 'loanId must be a positive integer');
  const info = returnLoanStmt.run(new Date().toISOString(), Number(loanId));
  if (info.changes === 0) {
    return sendJSON(res, 404, { error: 'no active loan with that id', field: 'loanId' });
  }
  return sendJSON(res, 200, { id: Number(loanId), returned: true });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && parts[0] === 'members' && parts[1] && parts[2] === 'loans' && parts.length === 3) {
      return handleMemberLoans(req, res, parts[1]);
    }
    if (req.method === 'POST' && parts[0] === 'loans' && parts.length === 1) {
      return await handleCreateLoan(req, res);
    }
    if (req.method === 'POST' && parts[0] === 'loans' && parts[2] === 'return' && parts.length === 3) {
      return handleReturnLoan(req, res, parts[1]);
    }
    return sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('Unexpected error:', err);
    return sendJSON(res, 500, { error: 'internal server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Library loans service listening on port ${PORT}`);
  });
}

module.exports = server;
