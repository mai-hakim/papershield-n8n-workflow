// build-workflow.js — writes workflow.json (import into n8n) from the step files in n8n-code/.
// No keys, passwords or real addresses are inside the workflow. The AI key stays in .env next to the helper.
const fs = require('fs');
const path = require('path');
const code = f => 'const data = $input.first().json;\n\n' + fs.readFileSync(path.join(__dirname, 'n8n-code', f), 'utf8') + '\nreturn [{ json: result }];';
const H = 'http://127.0.0.1:3457';
const post = (id, name, pos, url, body, extra = {}) => ({ id, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos,
  parameters: { method: 'POST', url: H + url, sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify(' + body + ') }}', options: { timeout: 120000 } }, ...extra });
const iff = (id, name, pos, expr) => ({ id, name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos,
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: id + 'c', leftValue: '={{ ' + expr + ' }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } });
const D = "$('Fixed rules decide').first().json";
const I = "$('Check input').first().json";

const nodes = [
  { id: 'n1', name: 'Letter form', type: 'n8n-nodes-base.formTrigger', typeVersion: 2.2, position: [0, 0], webhookId: 'papershield-letter',
    parameters: { formTitle: 'PaperShield — send a letter (synthetic test letters only)', formDescription: 'Paste the text of a made-up letter. An AI reads facts only; fixed rules decide; a person approves before anything is sent.',
      formFields: { values: [
        { fieldLabel: 'Your email (made-up, ends with @example.com)', fieldType: 'email', requiredField: true },
        { fieldLabel: 'Letter text (synthetic letters only)', fieldType: 'textarea', requiredField: true },
        { fieldLabel: 'May an AI write a short summary? (optional)', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'No' }, { option: 'Yes' }] } } ] },
      options: {} } },
  { id: 'n2', name: 'Letter in (test webhook)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 220], webhookId: 'papershield-letter-in',
    parameters: { httpMethod: 'POST', path: 'papershield-letter-in', responseMode: 'onReceived', options: {} } },
  { id: 'n3', name: 'Check input', type: 'n8n-nodes-base.code', typeVersion: 2, position: [240, 100], parameters: { jsCode: code('1-check-input.js') } },
  iff('n4', 'Input OK?', [460, 100], '$json.ok'),
  post('n5', 'Errors sheet: bad input', [700, 320], '/errors', "{ caseId: $json.caseId, letterId: '', email: $json.email, stage: 'check-input', error: $json.error }"),
  post('n6', 'Duplicate check', [700, 0], '/duplicate-check', '{ email: $json.email, letterText: $json.letterText }'),
  iff('n7', 'Duplicate?', [920, 0], '$json.duplicate'),
  post('n8', 'Log sheet: duplicate skipped', [1160, -200], '/log', `{ caseId: ${I}.caseId, letterId: $json.letterId, email: ${I}.email, status: 'duplicate-skipped' }`),
  post('n9', 'AI extracts facts only', [1160, 60], '/extract', `{ letterText: ${I}.letterText, wantSummary: ${I}.consent, simulate: ${I}.simulate }`, { onError: 'continueErrorOutput' }),
  post('n10', 'Errors sheet: AI tool down', [1400, 300], '/errors', `{ caseId: ${I}.caseId, letterId: $('Duplicate check').first().json.letterId, email: ${I}.email, stage: 'ai-extract', error: 'AI service did not answer (tool down). The letter was not decided.' }`),
  post('n11', 'Email: we will check by hand', [1640, 300], '/email', `{ to: ${I}.email, letterId: $('Duplicate check').first().json.letterId, subject: 'PaperShield: we could not read your letter automatically', body: 'Hello,\\n\\nOur reading service is not available right now, so we did not decide anything about your letter. A person will look at it. Please do not act on the letter until you hear back, and do not pay anyone who calls you about it.\\n\\nPaperShield (synthetic test message)' }`),
  post('n12', 'Log sheet: AI down', [1880, 300], '/log', `{ caseId: ${I}.caseId, letterId: $('Duplicate check').first().json.letterId, email: ${I}.email, status: 'error-ai-down', emailFile: $json.file }`),
  { id: 'n13', name: 'Fixed rules decide', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1400, 40], parameters: { jsCode: code('2-fixed-rules.js') } },
  post('n14', 'Ask a human to approve', [1640, 40], '/approval', `{ letterId: $json.letterId, caseId: $json.caseId, resumeUrl: $execution.resumeUrl, summary: $json }`),
  { id: 'n15', name: 'Wait for human decision', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [1880, 40], webhookId: 'papershield-approval',
    parameters: { resume: 'webhook', httpMethod: 'GET', options: {} } },
  iff('n16', 'Approved?', [2120, 40], "$json.query.decision === 'approve'"),
  iff('n17', 'Has a clear deadline?', [2360, -80], `!!${D}.dueDate && ${D}.outcome !== 'scam'`),
  post('n18', 'Calendar reminder (.ics)', [2600, -200], '/calendar', `{ letterId: ${D}.letterId, dueDate: ${D}.dueDate, title: 'Letter: ' + ${D}.headline }`),
  { id: 'n19', name: 'Write result email', type: 'n8n-nodes-base.code', typeVersion: 2, position: [2840, -80],
    parameters: { jsCode: `const d = ${D};\nconst cal = $('Calendar reminder (.ics)').isExecuted ? $('Calendar reminder (.ics)').first().json.file : '';\nconst lines = ['Hello,', '', 'PaperShield read your letter.', '', 'Result: ' + d.outcomeText, d.headline, '', 'Decided by fixed rule ' + d.rule + ' and checked by a person.'];\nif (d.aiUnsure) lines.push('Some words were hard to read (' + d.unsure.join(', ') + '). Please check the letter yourself or with someone you trust.');\nif (cal) lines.push('A calendar reminder was made for ' + d.dueText + ' (2 days before, you get an alert).');\nif (d.aiSummary) lines.push('', 'Short AI summary (you agreed to this): ' + d.aiSummary);\nlines.push('', 'PaperShield gives information, not financial or legal advice.', '(Synthetic test message.)');\nreturn [{ json: { to: d.email, letterId: d.letterId, subject: 'PaperShield: ' + d.outcomeText, body: lines.join('\\n'), calendarFile: cal } }];` } },
  post('n20', 'Email the result', [3080, -80], '/email', '{ to: $json.to, letterId: $json.letterId, subject: $json.subject, body: $json.body }'),
  post('n21', 'Log sheet: sent', [3320, -80], '/log', `{ caseId: ${D}.caseId, letterId: ${D}.letterId, email: ${D}.email, outcome: ${D}.outcome, rule: ${D}.rule, amount: ${D}.amount, dueDate: ${D}.dueDate, aiUnsure: ${D}.aiUnsure, humanDecision: 'approve', calendarFile: $('Write result email').first().json.calendarFile, emailFile: $json.file, status: 'sent' }`),
  post('n22', 'Log sheet: human rejected', [2360, 200], '/log', `{ caseId: ${D}.caseId, letterId: ${D}.letterId, email: ${D}.email, outcome: ${D}.outcome, rule: ${D}.rule, amount: ${D}.amount, dueDate: ${D}.dueDate, aiUnsure: ${D}.aiUnsure, humanDecision: 'reject', status: 'rejected-not-sent' }`),
  post('n23', 'Log sheet: bad input', [940, 320], '/log', `{ caseId: ${I}.caseId, email: ${I}.email, status: 'error-bad-input' }`),
  { id: 'n24', name: 'Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, -420], parameters: { width: 1100, height: 260, content:
    '## PaperShield letter workflow\nLetter in (form or test webhook) → fixed input checks → duplicate check → **AI extracts facts only** (Gemini, quotes checked against the letter) → **fixed rules decide** (R0–R10, same as the app) → **a human approves or rejects** → calendar reminder (.ics) → log sheet → result email.\nErrors (missing/wrong data, AI tool down) go to the **errors sheet**. Synthetic data only. Emails go to a local outbox; nothing is really sent.\nNeeds the helper running: `node helper/helper.js` (port 3457). The AI key is in .env, never in this workflow.' } }
];
const C = (from, ...to) => ({ [from]: { main: to.map(t => (t ? [].concat(t).map(n => ({ node: n, type: 'main', index: 0 })) : [])) } });
const connections = Object.assign({},
  C('Letter form', 'Check input'), C('Letter in (test webhook)', 'Check input'), C('Check input', 'Input OK?'),
  C('Input OK?', 'Duplicate check', 'Errors sheet: bad input'), C('Errors sheet: bad input', 'Log sheet: bad input'),
  C('Duplicate check', 'Duplicate?'), C('Duplicate?', 'Log sheet: duplicate skipped', 'AI extracts facts only'),
  C('AI extracts facts only', 'Fixed rules decide', 'Errors sheet: AI tool down'),
  C('Errors sheet: AI tool down', 'Email: we will check by hand'), C('Email: we will check by hand', 'Log sheet: AI down'),
  C('Fixed rules decide', 'Ask a human to approve'), C('Ask a human to approve', 'Wait for human decision'), C('Wait for human decision', 'Approved?'),
  C('Approved?', 'Has a clear deadline?', 'Log sheet: human rejected'), C('Has a clear deadline?', 'Calendar reminder (.ics)', 'Write result email'),
  C('Calendar reminder (.ics)', 'Write result email'), C('Write result email', 'Email the result'), C('Email the result', 'Log sheet: sent'));
fs.writeFileSync(path.join(__dirname, 'workflow.json'), JSON.stringify({ id: 'paperShieldFlow1', name: 'PaperShield letter workflow', active: false, nodes, connections, settings: { executionOrder: 'v1' }, pinData: {} }, null, 2));
console.log('workflow.json written (' + nodes.length + ' nodes)');
