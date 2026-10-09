// STEP: Fixed rules decide (no AI). Same decision table as the PaperShield app (R0–R10, scam signs first).
// Input: the facts the AI extracted + the original letter text. The AI never decides the outcome.
const inp = $('Check input').first().json;
const ai = data.facts || {};
const text = inp.letterText;
const low = text.toLowerCase();
const today = new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00Z');

// published word lists (same idea as js/rules.js in the app)
const STRONG_PAY = ['gift card', 'gift cards', 'wire transfer', 'bitcoin', 'crypto', 'cryptocurrency', 'money order', 'zelle', 'cash app', 'western union', 'prepaid card'];
const URGENCY = ['act now', 'immediately', 'within 24 hours', 'final notice', 'arrest', 'warrant', 'suspended', 'frozen', 'urgent', 'do not tell anyone'];
const AGENCIES = [{ names: ['irs', 'internal revenue'], site: 'irs.gov' }, { names: ['social security', 'ssa'], site: 'ssa.gov' }, { names: ['medicare'], site: 'medicare.gov' }];

const unsure = new Set((ai.unsure_fields || []).map(String));
// fixed data checks on what the AI returned ("wrong data" from the AI side)
const validDate = s => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false; const d = new Date(s + 'T12:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; };
if (ai.due_date && !validDate(ai.due_date)) unsure.add('due_date');
if (ai.amount_owed != null && (typeof ai.amount_owed !== 'number' || ai.amount_owed < 0 || ai.amount_owed > 1e6)) unsure.add('amount_owed');

const signals = [];
const payHit = STRONG_PAY.filter(w => low.includes(w)).concat((ai.payment_methods_requested || []).filter(m => STRONG_PAY.some(w => String(m).toLowerCase().includes(w))));
if (payHit.length) signals.push({ id: 'payment', strength: 'strong', raw: payHit[0] });
if (ai.asks_for_ssn || (/social security number|\bssn\b/.test(low) && /(verify|confirm|provide|have .* ready|send)/.test(low))) signals.push({ id: 'ssn', strength: 'strong', raw: 'asks for SSN' });
const agency = AGENCIES.find(a => a.names.some(n => new RegExp('\\b' + n + '\\b').test(low)));
const hosts = (ai.links || []).concat(text.match(/\b[a-z0-9.-]+\.(com|net|org|gov|info|biz|co)\b/gi) || []).map(h => String(h).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]);
const bad = agency && hosts.find(h => !(h === agency.site || h.endsWith('.' + agency.site)));
if (bad) signals.push({ id: 'link', strength: 'strong', raw: bad });
const urg = URGENCY.filter(w => low.includes(w));
if (urg.length) signals.push({ id: 'urgency', strength: urg.length >= 2 ? 'strong' : 'normal', raw: urg.slice(0, 3).join(', ') });

const words = text.split(/\s+/).filter(w => /[a-z]{2,}/i.test(w)).length;
const readable = words >= 12;
let deadlineState = 'none', daysLeft = null;
if (unsure.has('due_date') && /(due|pay by|before|deadline|by )/i.test(text)) deadlineState = 'unclear';
else if (ai.due_date && validDate(ai.due_date)) { daysLeft = Math.round((new Date(ai.due_date + 'T12:00:00Z') - today) / 864e5); deadlineState = daysLeft < 0 ? 'overdue' : daysLeft <= 3 ? 'urgent' : daysLeft <= 14 ? 'soon' : 'later'; }
const money = unsure.has('amount_owed') && /\$/.test(text) ? 'unclear' : ai.amount_owed > 0 ? 'owe' : ai.amount_to_receive > 0 ? 'receive' : 'none';
const strong = signals.filter(s => s.strength === 'strong').length;

const TABLE = [
  ['R0', !readable, 'cantRead'], ['R1', strong >= 1, 'scam'], ['R2', signals.length >= 2, 'scam'], ['R3', signals.length === 1, 'help'],
  ['R4', !!ai.signature_required, 'help'], ['R5', deadlineState === 'overdue' && money === 'owe', 'help'], ['R6', deadlineState === 'unclear' && money === 'owe', 'help'],
  ['R7', money === 'owe', 'action'], ['R8', deadlineState !== 'none', 'action'], ['R9', money === 'unclear', 'help'], ['R10', true, 'none']];
const [rule, , outcome] = TABLE.find(r => r[1]);
const aiUnsure = unsure.size > 0;
const TEXT = { none: 'No action needed', action: 'Action needed', help: 'Ask someone you trust', scam: 'Careful — signs of a scam', cantRead: "I can't read this" };
const amt = ai.amount_owed != null ? '$' + Number(ai.amount_owed).toFixed(2) : null;
const nice = d => { const M = ['January','February','March','April','May','June','July','August','September','October','November','December']; const x = new Date(d + 'T12:00:00Z'); return M[x.getUTCMonth()] + ' ' + x.getUTCDate() + ', ' + x.getUTCFullYear(); };
const dueText = ai.due_date && validDate(ai.due_date) && deadlineState !== 'unclear' ? nice(ai.due_date) : null;
const headline = outcome === 'scam' ? "Don't pay, don't call the number, don't send your Social Security number." :
  outcome === 'action' && money === 'owe' ? `Pay ${amt}${dueText ? ' by ' + dueText : ''}.` :
  outcome === 'action' && dueText ? `Respond by ${dueText}.` :
  outcome === 'action' ? 'There is a date on this letter, but it could not be read clearly. Check the letter with someone you trust before the date.' : outcome === 'help' && ai.signature_required ? 'This letter needs your signature. Ask someone you trust to look at it with you.' :
  outcome === 'help' ? 'Show this letter to someone you trust before you do anything.' : outcome === 'cantRead' ? 'Please send the full letter text.' : 'Nothing to do. Keep it for your records.';
const facts = [['From', ai.sender || '(not found)'], ['Type', ai.letter_type], ['Amount owed', amt || 'none'], ['Due date', ai.due_date || 'none'], ['Signature needed', ai.signature_required ? 'yes' : 'no'],
  ['Payment methods asked', (ai.payment_methods_requested || []).join(', ') || 'none'], ['Asks for SSN', ai.asks_for_ssn ? 'yes' : 'no'], ['Quote check', JSON.stringify(ai.quote_check || {})]];
const result = {
  caseId: inp.caseId, email: inp.email, letterId: $('Duplicate check').first().json.letterId, letterText: text,
  outcome, rule, outcomeText: TEXT[outcome] + (aiUnsure && outcome !== 'scam' ? ' (not sure — please check)' : ''), headline, signals, deadlineState, daysLeft,
  dueDate: deadlineState !== 'unclear' && deadlineState !== 'none' ? ai.due_date : null, dueText, amount: amt, aiUnsure, unsure: [...unsure], facts,
  aiSummary: inp.consent ? ai.summary || null : null, aiModel: data.model
};
