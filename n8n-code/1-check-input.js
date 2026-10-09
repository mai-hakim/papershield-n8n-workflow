// STEP: Check input (fixed rules, no AI). Works for the n8n form and for the test webhook.
const j = $input.first().json;
const src = j.body ? j.body : j;              // webhook puts fields in "body"
const pick = (...keys) => { for (const k of keys) if (src[k] != null && src[k] !== '') return String(src[k]); return ''; };
const email = pick('email', 'Your email (made-up, ends with @example.com)').trim();
const letterText = pick('letterText', 'Letter text (synthetic letters only)').trim();
const consent = /^(yes|true|1)$/i.test(pick('aiSummaryConsent', 'May an AI write a short summary? (optional)'));
const caseId = pick('caseId') || 'form-' + Date.now();
const simulate = pick('simulate');            // only used by the automated test cases ("ai-down")

const problems = [];
if (!letterText) problems.push('missing data: no letter text');
else if (letterText.split(/\s+/).filter(w => /[a-z]{2,}/i.test(w)).length < 8) problems.push('missing data: the letter text is too short to read (fewer than 8 words)');
if (!email) problems.push('missing data: no email address');
else if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) problems.push('wrong data: "' + email + '" is not an email address');
else if (!/@example\.(com|org|net)$/i.test(email)) problems.push('wrong data: only synthetic @example.com addresses are allowed in this demo');
if (letterText.length > 20000) problems.push('wrong data: the letter is longer than 20,000 characters');

const result = { ok: problems.length === 0, problems, error: problems.join('; '), caseId, email, letterText, consent, simulate };
