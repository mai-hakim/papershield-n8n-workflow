// run-tests.js — sends the 7 test cases to the running n8n workflow and checks what happened.
// Needs: n8n running (`npx n8n start`) with the workflow published, and the helper on port 3457.
// The "human" decision is given through the same approval page a person would use.
const fs = require('fs');
const path = require('path');
const N8N = process.env.N8N_URL || 'http://localhost:5678';
const HELPER = 'http://127.0.0.1:3457';
const OUT = path.join(__dirname, '..', 'out');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-cases.json'), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rows = f => { const p = path.join(OUT, f); if (!fs.existsSync(p)) return []; const [h, ...r] = fs.readFileSync(p, 'utf8').trim().split('\n'); const k = h.split(','); return r.map(l => { const v = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')); return Object.fromEntries(k.map((x, i) => [x, v[i]])); }); };

(async () => {
  const runTag = 'run' + Date.now().toString(36);
  // start from empty sheets so the duplicate test is honest on every run (old sheets are kept as a backup)
  for (const [f, head] of [['log-sheet.csv', 'time,case_id,letter_id,email,outcome,rule,amount,due_date,ai_unsure,human_decision,calendar_file,email_file,status'], ['errors-sheet.csv', 'time,case_id,letter_id,email,stage,error']]) {
    const p = path.join(OUT, f); if (fs.existsSync(p)) fs.copyFileSync(p, p.replace('.csv', '-before-' + runTag + '.csv')); fs.writeFileSync(p, head + '\n');
  }
  const results = [];
  for (const c of cases) {
    const caseId = c.id + '-' + runTag;
    const body = { ...c.input, caseId };
    const t0 = Date.now();
    const r = await fetch(N8N + '/webhook/papershield-letter-in', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(e => ({ status: 'error ' + e.message }));
    let approval = null;
    // wait for: an approval request (then decide like a human), or a final row in the log sheet
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const pend = await fetch(HELPER + '/pending').then(x => x.json()).catch(() => []);
      const mine = pend.find(p => p.caseId === caseId);
      if (mine && !approval) {
        approval = { outcome: mine.outcome, aiUnsure: mine.aiUnsure, decision: c.human || 'approve' };
        await fetch(HELPER + '/approval/' + mine.id + '/' + approval.decision).catch(() => {});
      }
      if (rows('log-sheet.csv').some(x => x.case_id === caseId)) break;
    }
    await sleep(1200);
    const log = rows('log-sheet.csv').filter(x => x.case_id === caseId);
    const errs = rows('errors-sheet.csv').filter(x => x.case_id === caseId);
    const last = log[log.length - 1] || {};
    const emailText = last.email_file && fs.existsSync(path.join(OUT, last.email_file)) ? fs.readFileSync(path.join(OUT, last.email_file), 'utf8').split('\r\n\r\n').slice(1).join('\n') : '';
    const got = { webhook: r.status, status: last.status || '(no log row)', outcome: last.outcome || (approval && approval.outcome) || '', aiUnsure: last.ai_unsure || (approval ? String(approval.aiUnsure) : ''),
      calendar: !!last.calendar_file, email: !!last.email_file, errorsRows: errs.length, errorStage: errs.map(e => e.stage).join(' '), human: approval ? approval.decision : '-', emailText, seconds: Math.round((Date.now() - t0) / 1000) };
    const e = c.expect;
    const checks = [
      ['status', got.status === e.status],
      e.outcome ? ['outcome', got.outcome === e.outcome] : null,
      e.aiUnsure != null ? ['ai unsure flag', got.aiUnsure === String(e.aiUnsure)] : null,
      e.calendar != null ? ['calendar', got.calendar === e.calendar] : null,
      e.email != null ? ['email', got.email === e.email] : null,
      e.errorStage ? ['errors sheet', got.errorStage.includes(e.errorStage)] : null,
      got.email ? ['email has no "null"/"undefined" and no raw dates', !/(null|undefined)|\d{4}-\d{2}-\d{2}/.test(got.emailText)] : null
    ].filter(Boolean);
    const pass = checks.every(x => x[1]);
    results.push({ id: c.id, title: c.title, expect: e, got, pass, failedChecks: checks.filter(x => !x[1]).map(x => x[0]) });
    console.log((pass ? 'PASS ' : 'FAIL ') + c.id + ' — ' + JSON.stringify({ ...got, emailText: undefined }) + (pass ? '' : ' expected ' + JSON.stringify(e)));
  }
  const summary = { ranAt: new Date().toISOString(), passed: results.filter(r => r.pass).length, total: results.length, results };
  fs.writeFileSync(path.join(OUT, 'test-results-' + runTag + '.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'test-results-latest.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${summary.passed} of ${summary.total} test cases passed`);
})();
