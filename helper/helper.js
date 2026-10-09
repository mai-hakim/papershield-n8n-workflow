// helper.js — small local service that the n8n workflow calls (http://127.0.0.1:3457).
// It does the parts n8n cannot do safely or for free on a laptop:
//   /extract   AI (Gemini free tier) reads the letter and returns FACTS ONLY, each with the exact quote it came from.
//   /approval  shows a human the result and waits for Approve / Reject (the n8n Wait node resumes on the answer).
//   /calendar  writes a calendar reminder (.ics file you can open in any calendar app).
//   /log, /errors  append a row to the log sheet / errors sheet (CSV files that open in Excel or Google Sheets).
//   /email     writes the result email into a local outbox (.eml files). NO real email is sent.
// The key stays in .env on this laptop. It is never in the n8n workflow and never in GitHub.
// All letters and addresses used with this project are synthetic (made up).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3457;
const OUT = path.join(__dirname, '..', 'out');
['calendar', 'outbox'].forEach(d => fs.mkdirSync(path.join(OUT, d), { recursive: true }));
const LOG = path.join(OUT, 'log-sheet.csv'), ERR = path.join(OUT, 'errors-sheet.csv');
const LOG_HEAD = 'time,case_id,letter_id,email,outcome,rule,amount,due_date,ai_unsure,human_decision,calendar_file,email_file,status\n';
const ERR_HEAD = 'time,case_id,letter_id,email,stage,error\n';
if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, LOG_HEAD);
if (!fs.existsSync(ERR)) fs.writeFileSync(ERR, ERR_HEAD);

function key() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  for (const f of [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', '..', 'test-harness', '.env')]) {
    if (fs.existsSync(f)) { const m = fs.readFileSync(f, 'utf8').match(/^GEMINI_API_KEY=(.+)$/m); if (m && !/PASTE/.test(m[1])) return m[1].trim(); }
  }
  return null;
}
const csv = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
const readBody = req => new Promise((ok, bad) => { let s = ''; req.on('data', c => (s += c)); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } }); });
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- AI: facts only ----------
const FACT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sender: { type: 'STRING', nullable: true }, sender_quote: { type: 'STRING', nullable: true },
    letter_type: { type: 'STRING', enum: ['bill', 'insurance', 'government', 'medical', 'advertisement', 'other'] },
    amount_owed: { type: 'NUMBER', nullable: true }, amount_quote: { type: 'STRING', nullable: true },
    amount_to_receive: { type: 'NUMBER', nullable: true },
    due_date: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD, only if written in the letter' }, due_date_quote: { type: 'STRING', nullable: true },
    signature_required: { type: 'BOOLEAN' }, signature_quote: { type: 'STRING', nullable: true },
    payment_methods_requested: { type: 'ARRAY', items: { type: 'STRING' } },
    asks_for_ssn: { type: 'BOOLEAN' }, links: { type: 'ARRAY', items: { type: 'STRING' } },
    pressure_phrases: { type: 'ARRAY', items: { type: 'STRING' } },
    unsure_fields: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Names of fields you could not read for sure' },
    summary: { type: 'STRING', nullable: true, description: 'Two plain sentences for an older reader. Only if asked.' }
  },
  required: ['letter_type', 'signature_required', 'asks_for_ssn', 'payment_methods_requested', 'links', 'pressure_phrases', 'unsure_fields']
};
async function extract({ letterText, wantSummary, simulate }) {
  if (simulate === 'ai-down') { const e = new Error('Simulated: AI service is down (test case "tool down")'); e.code = 503; throw e; }
  const k = key(); if (!k) { const e = new Error('No Gemini key on this laptop'); e.code = 503; throw e; }
  const prompt = `Read this letter and return FACTS ONLY as JSON. Do not decide what the reader should do. Do not guess.\n` +
    `For sender, amount and due date, also copy the exact words from the letter into the *_quote field. If a value is smudged, unclear or missing, use null and list the field in unsure_fields.\n` +
    (wantSummary ? 'The reader agreed to an AI summary: fill "summary" with two plain sentences.\n' : 'Leave "summary" null.\n') + '\nLETTER:\n' + letterText;
  let lastErr;
  for (const model of ['gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash']) for (let a = 0; a < 2; a++) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: FACT_SCHEMA } }) });
      if (r.status === 429 || r.status >= 500) { lastErr = new Error('AI HTTP ' + r.status); await new Promise(z => setTimeout(z, 8000)); continue; }
      const j = await r.json(); if (!r.ok) throw new Error('AI HTTP ' + r.status);
      const facts = JSON.parse(j.candidates[0].content.parts.map(p => p.text || '').join(''));
      return { model, facts: verifyQuotes(facts, letterText) };
    } catch (e) { lastErr = e; }
  }
  const e = new Error('AI service did not answer: ' + (lastErr && lastErr.message)); e.code = 503; throw e;
}
// Fixed check against made-up facts: every quote must really be in the letter. If not, the field is marked unsure.
function verifyQuotes(f, text) {
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const t = norm(text); f.unsure_fields = Array.isArray(f.unsure_fields) ? f.unsure_fields : []; f.quote_check = {};
  for (const [field, q] of [['sender', 'sender_quote'], ['amount_owed', 'amount_quote'], ['due_date', 'due_date_quote']]) {
    if (f[field] == null || f[field] === '') { f.quote_check[field] = 'no value'; continue; }
    const ok = f[q] && t.includes(norm(f[q]));
    f.quote_check[field] = ok ? 'quote found in letter' : 'quote NOT found in letter';
    if (!ok && !f.unsure_fields.includes(field)) f.unsure_fields.push(field);
  }
  return f;
}

// ---------- approvals (human in the loop) ----------
const pending = new Map(); // id -> { resumeUrl, summary, created, decided }
function approvalPage(id, p) {
  const s = p.summary || {};
  const color = { none: '#1C6E40', action: '#9A4A00', help: '#6A3FA0', scam: '#B42318' }[s.outcome] || '#3F565C';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve letter result</title>
<style>body{font:18px/1.5 system-ui,sans-serif;background:#EEF3F6;color:#0F2A30;max-width:640px;margin:0 auto;padding:16px}.card{background:#fff;border-radius:16px;padding:16px;border:1px solid #CFDCE1;margin:12px 0}.res{border-top:6px solid ${color};text-align:center}.res b{color:${color};font-size:1.4em}
.warn{background:#FDECEA;border:2px solid #B42318;border-radius:12px;padding:10px;font-weight:700}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px}dt{font-weight:700;color:#3F565C}dd{margin:0}
.btns{display:flex;gap:12px}.btns a{flex:1;text-align:center;padding:16px;border-radius:14px;font-weight:700;text-decoration:none;font-size:1.1em}.ok{background:#0F6B6B;color:#fff}.no{background:#fff;color:#B42318;border:2px solid #B42318}</style></head><body>
<h1>👤 Human approval needed</h1><p>Letter <b>${esc(id)}</b> from a synthetic test user (${esc(s.email)}). Nothing is sent until you decide.</p>
<div class="card res"><b>${esc(s.outcomeText)}</b><p>${esc(s.headline)}</p><small>Decided by fixed rule ${esc(s.rule)} — not by the AI.</small></div>
${s.aiUnsure ? `<div class="warn">⚠ The AI was not sure about: ${esc((s.unsure || []).join(', '))}. Check the letter yourself.</div>` : ''}
<div class="card"><h2>Facts the AI extracted (with quotes checked against the letter)</h2><dl>${(s.facts || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>
${s.aiSummary ? `<div class="card"><h2>AI summary (reader gave consent)</h2><p>${esc(s.aiSummary)}</p></div>` : ''}
<div class="card"><h2>The letter</h2><pre style="white-space:pre-wrap;font-size:15px">${esc(s.letterText)}</pre></div>
${p.decided ? `<p class="card">Decision recorded: <b>${esc(p.decided)}</b>.</p>` : `<div class="btns"><a class="ok" href="/approval/${esc(id)}/approve">✅ Approve and send</a><a class="no" href="/approval/${esc(id)}/reject">✋ Reject — do not send</a></div>`}
</body></html>`;
}

// ---------- server ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, aiKey: !!key(), pending: pending.size });
    if (req.method === 'POST' && url.pathname === '/extract') {
      const b = await readBody(req);
      try { return send(res, 200, await extract(b)); } catch (e) { return send(res, e.code || 500, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/duplicate-check') {
      const b = await readBody(req);
      const hash = crypto.createHash('sha256').update(String(b.email || '').toLowerCase() + '|' + String(b.letterText || '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
      const seen = fs.readFileSync(LOG, 'utf8').split('\n').some(l => l.includes(',' + hash + ',') && /,sent$|,approved-no-email$/.test(l.trim()));
      return send(res, 200, { letterId: hash, duplicate: seen });
    }
    if (req.method === 'POST' && url.pathname === '/approval') {
      const b = await readBody(req); const id = b.letterId + '-' + Date.now().toString(36);
      pending.set(id, { resumeUrl: b.resumeUrl, summary: b.summary, caseId: b.caseId, created: new Date().toISOString(), decided: null });
      return send(res, 200, { approvalId: id, approvalPage: `http://127.0.0.1:${PORT}/approval/${id}` });
    }
    if (req.method === 'GET' && url.pathname === '/pending') return send(res, 200, [...pending].filter(([, p]) => !p.decided).map(([id, p]) => ({ id, caseId: p.caseId, outcome: p.summary && p.summary.outcome, aiUnsure: p.summary && p.summary.aiUnsure, page: `http://127.0.0.1:${PORT}/approval/${id}` })));
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/approval\/([\w-]+)$/))) { const p = pending.get(m[1]); return p ? send(res, 200, approvalPage(m[1], p), 'text/html; charset=utf-8') : send(res, 404, 'Unknown approval', 'text/plain'); }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/approval\/([\w-]+)\/(approve|reject)$/))) {
      const p = pending.get(m[1]); if (!p) return send(res, 404, 'Unknown approval', 'text/plain');
      if (!p.decided) { p.decided = m[2]; const r = await fetch(p.resumeUrl + (p.resumeUrl.includes('?') ? '&' : '?') + 'decision=' + m[2]).catch(e => ({ status: 'error ' + e.message })); p.resumeStatus = r.status; }
      return send(res, 200, approvalPage(m[1], p), 'text/html; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/calendar') {
      const b = await readBody(req); const d = String(b.dueDate).replace(/-/g, '');
      const f = `reminder-${b.letterId}-${d}.ics`;
      const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PaperShield n8n workflow//EN', 'BEGIN:VEVENT', `UID:${b.letterId}-${d}@papershield.example`,
        'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z', `DTSTART;VALUE=DATE:${d}`, 'SUMMARY:' + String(b.title).replace(/[,;\n]/g, ' '),
        'DESCRIPTION:Reminder created by the PaperShield workflow (synthetic test data).', 'BEGIN:VALARM', 'TRIGGER:-P2D', 'ACTION:DISPLAY', 'DESCRIPTION:Letter deadline in 2 days', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
      fs.writeFileSync(path.join(OUT, 'calendar', f), ics); return send(res, 200, { file: 'calendar/' + f });
    }
    if (req.method === 'POST' && url.pathname === '/log') {
      const b = await readBody(req);
      fs.appendFileSync(LOG, [new Date().toISOString(), b.caseId, b.letterId, b.email, b.outcome, b.rule, b.amount, b.dueDate, b.aiUnsure, b.humanDecision, b.calendarFile, b.emailFile, b.status].map(csv).join(',') + '\n');
      return send(res, 200, { logged: true });
    }
    if (req.method === 'POST' && url.pathname === '/errors') {
      const b = await readBody(req);
      fs.appendFileSync(ERR, [new Date().toISOString(), b.caseId, b.letterId, b.email, b.stage, b.error].map(csv).join(',') + '\n');
      return send(res, 200, { logged: true });
    }
    if (req.method === 'POST' && url.pathname === '/email') {
      const b = await readBody(req);
      if (!/^[^@\s]+@example\.(com|org|net)$/i.test(b.to || '')) return send(res, 400, { error: 'Only synthetic @example.com addresses are allowed in this project.' });
      const f = `${Date.now()}-${String(b.letterId || 'x').slice(0, 16)}.eml`;
      const eml = `From: PaperShield workflow <papershield@example.com>\r\nTo: ${b.to}\r\nSubject: ${b.subject}\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${b.body}\r\n`;
      fs.writeFileSync(path.join(OUT, 'outbox', f), eml); return send(res, 200, { file: 'outbox/' + f, note: 'Saved to the local outbox. No real email was sent.' });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const rows = f => fs.readFileSync(f, 'utf8').trim().split('\n').map(l => '<tr>' + l.split(',').map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('');
      const box = fs.readdirSync(path.join(OUT, 'outbox')).slice(-10).map(f => `<li>${esc(f)}</li>`).join('');
      return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>PaperShield workflow — sheets</title><style>body{font:15px system-ui;padding:16px;background:#EEF3F6}table{border-collapse:collapse;background:#fff}td{border:1px solid #CFDCE1;padding:4px 6px}h2{color:#0F6B6B}</style></head><body>
<h1>PaperShield workflow — log sheet, errors sheet, outbox</h1><p>Synthetic test data only. Emails are saved locally, never sent.</p><h2>Log sheet</h2><table>${rows(LOG)}</table><h2>Errors sheet</h2><table>${rows(ERR)}</table><h2>Outbox (last 10)</h2><ul>${box}</ul></body></html>`, 'text/html; charset=utf-8');
    }
    send(res, 404, { error: 'Unknown address' });
  } catch (e) { console.error(e); send(res, 500, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => console.log('PaperShield workflow helper on http://127.0.0.1:' + PORT + ' (AI key: ' + (key() ? 'found' : 'MISSING') + ')'));
