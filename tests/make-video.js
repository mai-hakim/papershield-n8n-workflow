// make-video.js — records the Project B demo (about 80 s) with Playwright. Needs n8n + helper running.
// Story: a scam letter comes in through the n8n form -> AI reads facts -> fixed rules say "scam" -> the human rejects;
// then a smudged letter -> "AI unsure" shown in red to the human; then the sheets: log + errors (tool down caught).
const path = require('path'), fs = require('fs');
const { chromium } = require(path.join(__dirname, '..', '..', 'test-harness', 'node_modules', 'playwright'));
const OUTFILE = path.join(__dirname, '..', 'docs', 'demo', 'papershield-n8n-demo.webm');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-cases.json'), 'utf8'));
const scam = cases.find(c => c.id === '7-human-rejects').input.letterText;
const smudged = cases.find(c => c.id === '5-ai-unsure').input;
const wait = ms => new Promise(r => setTimeout(r, ms));
const cap = (p, t) => p.evaluate(t => { let c = document.getElementById('cap'); if (!c) { c = document.createElement('div'); c.id = 'cap';
  c.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;padding:12px 16px;border-radius:14px;background:rgba(15,42,48,.93);color:#fff;font:700 19px/1.35 system-ui,sans-serif;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,.3);pointer-events:none'; document.body.appendChild(c); } c.textContent = t; }, t);
const pendingFor = async (pred) => { for (let i = 0; i < 60; i++) { const l = await fetch('http://127.0.0.1:3457/pending').then(r => r.json()); const m = l.find(pred); if (m) return m; await wait(1000); } return null; };

(async () => {
  fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });
  const tmp = path.join(path.dirname(OUTFILE), 'tmp'); fs.mkdirSync(tmp, { recursive: true });
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1000, height: 760 }, recordVideo: { dir: tmp, size: { width: 1000, height: 760 } } });
  // the smudged letter goes in first, in the background, so the AI has read it by the time we show it
  await fetch('http://localhost:5678/webhook/papershield-letter-in', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...smudged, caseId: 'video-ai-unsure-' + Date.now().toString(36) }) });
  const p = await ctx.newPage(); const t0 = Date.now();
  await p.goto('http://localhost:5678/form/papershield-letter'); await p.waitForTimeout(800);
  await cap(p, 'PaperShield on n8n. A letter comes in through this n8n form. (Synthetic letter, made-up address.)'); await wait(3500);
  await p.locator('input').first().fill('walter.test@example.com');
  await p.locator('textarea').first().click(); await p.keyboard.type(scam.slice(0, 120), { delay: 8 }); await p.locator('textarea').first().fill(scam);
  await cap(p, 'It is a fake "IRS" letter: gift cards, SSN, an arrest threat.'); await wait(3000);
  const before = Date.now();
  await p.locator('button[type=submit], button:has-text("Submit")').first().click(); await wait(1500);
  await cap(p, 'n8n: input checks → duplicate check → AI extracts FACTS ONLY → fixed rules decide.'); await wait(3500);
  const m = await pendingFor(x => x.outcome === 'scam');
  await p.goto(m.page); await wait(500);
  await cap(p, 'A person must approve. Fixed rule R1 says: signs of a scam. The AI did not decide that.'); await wait(5500);
  await p.mouse.wheel(0, 380); await cap(p, 'The facts the AI found, with its quotes checked against the letter.'); await wait(4500);
  await p.mouse.wheel(0, 900); await wait(800);
  await cap(p, 'The reviewer rejects: nothing is sent to anyone. The decision is logged.'); await wait(3000);
  await p.locator('a.no').click(); await wait(3000);
  // AI unsure case through the test webhook
  const u = await pendingFor(x => x.aiUnsure === true);
  if (u) { await p.goto(u.page); await wait(400); await cap(p, 'Another letter: the amount and date are smudged. The AI says it is NOT sure — shown in red to the human.'); await wait(6000);
    await p.mouse.wheel(0, 1200); await wait(600); await p.locator('a.ok').click(); await wait(2000); }
  await p.goto('http://127.0.0.1:3457/'); await wait(400);
  await cap(p, 'Log sheet and errors sheet (CSV). Earlier test runs: missing data, wrong email, AI tool down — all caught.'); await wait(6500);
  await p.mouse.wheel(0, 500); await wait(3500);
  await cap(p, 'AI reads facts. Fixed rules decide. A person approves. Designed by Mai Hakim; code written with Claude.'); await wait(5000);
  const secs = Math.round((Date.now() - t0) / 1000); void before;
  const v = p.video(); await ctx.close(); await v.saveAs(OUTFILE); await v.delete(); fs.rmSync(tmp, { recursive: true, force: true }); await b.close();
  console.log('saved', OUTFILE, '~' + secs + ' s', Math.round(fs.statSync(OUTFILE).size / 1024) + ' KB');
})();
