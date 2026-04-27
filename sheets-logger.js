// ============================================================
// SHEETS LOGGER — Movement Clinic webhook server
// ============================================================
// Writes call events, marketing funnel updates, and conversions
// to the financial dashboard sheet (BUSINESS_SHEET_ID).
//
// All functions are designed to FAIL OPEN — sheet write errors
// are logged but never thrown, so a sheets outage cannot break
// the call processing pipeline.
//
// Tabs are auto-created on first write (matches existing
// ensureHealthTab pattern from index.js).
//
// Idempotency:
//  - logCallEvent: skips if call_sid already present
//  - upsertFunnelRow: matches on lead_id, updates in place
//  - logConversion: append-only, no dedup (form is one-shot)
// ============================================================

const { google } = require('googleapis');

const BUSINESS_SHEET_ID = '1tQmCNgqdQg_ijSpxYfC6iD4J4NfFhSiz2krpeU0xAG4';

// Bump this when the Claude prompt changes meaningfully.
// Stamped on every call_events row for prompt drift tracking.
const PROMPT_VERSION = '2026.04.27';

// Tab schemas — header rows. Order is the source of truth.
const FUNNEL_HEADERS = [
  'lead_id', 'first_name', 'last_name', 'phone',
  'source_pipeline', 'first_call_date', 'last_call_date', 'total_touchpoints',
  'current_stage', 'eval_scheduled_date', 'eval_held', 'post_eval_submitted',
  'conversion_outcome', 'objection', 'first_visit_date', 'last_updated'
];

const CALL_EVENTS_HEADERS = [
  'timestamp', 'call_sid', 'lead_id', 'pt_handler',
  'outcome', 'confidence_score', 'stage_before', 'stage_after',
  'pipeline', 'prompt_version', 'transcript_length', 'processing_ms'
];

const CONVERSIONS_HEADERS = [
  'timestamp', 'lead_id', 'pt_name', 'outcome',
  'problem', 'treatment_plan', 'objection', 'follow_up_details'
];

// ============================================================
// Sheets client — reuses the existing GOOGLE_SERVICE_ACCOUNT_JSON
// ============================================================
function getSheetsClient() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!sa.client_email) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing or invalid');
  }
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

// ============================================================
// Tab management — create tab + header row on first call
// Caches "ready" state in-memory so we only check once per process
// ============================================================
const tabReady = {
  marketing_funnel: false,
  call_events: false,
  conversions: false
};

async function ensureTab(sheets, tabName, headers) {
  if (tabReady[tabName]) return;
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: BUSINESS_SHEET_ID });
    const exists = meta.data.sheets.some(s => s.properties.title === tabName);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: BUSINESS_SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] }
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: BUSINESS_SHEET_ID,
        range: `${tabName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headers] }
      });
      console.log(`[sheets-logger] Created tab "${tabName}" with ${headers.length} headers`);
    }
    tabReady[tabName] = true;
  } catch (err) {
    console.error(`[sheets-logger] ensureTab(${tabName}) failed:`, err.message);
    // Don't mark ready — let next call retry
  }
}

// ============================================================
// logCallEvent — append-only, dedup by call_sid
// ============================================================
async function logCallEvent({
  callSid, leadId, ptHandler, outcome, confidenceScore,
  stageBefore, stageAfter, pipeline, transcriptLength, processingMs
}) {
  try {
    if (!callSid) {
      console.warn('[logCallEvent] skipped — no callSid provided');
      return;
    }
    const sheets = getSheetsClient();
    await ensureTab(sheets, 'call_events', CALL_EVENTS_HEADERS);

    // Dedup check — read column B (call_sid) and bail if already present
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: BUSINESS_SHEET_ID,
      range: 'call_events!B:B'
    }).catch(() => ({ data: { values: [] } }));
    const sids = (existing.data.values || []).flat();
    if (sids.includes(callSid)) {
      console.log(`[logCallEvent] skipped — call_sid ${callSid} already logged`);
      return;
    }

    const row = [
      new Date().toISOString(),
      callSid,
      leadId || '',
      ptHandler || '',
      outcome || '',
      confidenceScore != null ? String(confidenceScore) : '',
      stageBefore || '',
      stageAfter || '',
      pipeline || '',
      PROMPT_VERSION,
      transcriptLength != null ? String(transcriptLength) : '',
      processingMs != null ? String(processingMs) : ''
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: BUSINESS_SHEET_ID,
      range: 'call_events!A:L',
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  } catch (err) {
    console.error('[logCallEvent] failed:', err.message);
  }
}

// ============================================================
// upsertFunnelRow — matches on lead_id, updates in place or appends
// Designed to be called on every webhook event so the funnel
// row reflects the most recent known state of the lead.
// ============================================================
async function upsertFunnelRow({
  leadId, firstName, lastName, phone, sourcePipeline,
  currentStage, evalScheduled, evalHeld, firstVisitDate
}) {
  try {
    if (!leadId) {
      console.warn('[upsertFunnelRow] skipped — no leadId provided');
      return;
    }
    const sheets = getSheetsClient();
    await ensureTab(sheets, 'marketing_funnel', FUNNEL_HEADERS);

    // Read full tab to find existing row by lead_id
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: BUSINESS_SHEET_ID,
      range: 'marketing_funnel!A:P'
    }).catch(() => ({ data: { values: [] } }));
    const rows = existing.data.values || [];
    const now = new Date().toISOString();

    // Find row index (1-based for Sheets, +1 because header is row 1)
    let rowIdx = -1;
    let existingRow = null;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === leadId) {
        rowIdx = i + 1; // sheet row number
        existingRow = rows[i];
        break;
      }
    }

    if (existingRow) {
      // UPDATE — preserve locked fields, increment touchpoints
      const newRow = [
        leadId,
        existingRow[1] || firstName || '',
        existingRow[2] || lastName || '',
        existingRow[3] || phone || '',
        existingRow[4] || sourcePipeline || '',  // source locked after first
        existingRow[5] || now,                    // first_call_date locked
        now,                                       // last_call_date updated
        String((parseInt(existingRow[7]) || 0) + 1), // total_touchpoints++
        currentStage || existingRow[8] || '',
        // eval_scheduled_date locks once set
        existingRow[9] || (evalScheduled ? now : ''),
        // eval_held: true if EITHER existing was true OR PTEverywhere shows past first_appointment
        (existingRow[10] === 'TRUE' || evalHeld) ? 'TRUE' : 'FALSE',
        existingRow[11] || 'FALSE',  // post_eval_submitted set by logConversion
        existingRow[12] || '',        // conversion_outcome set by logConversion
        existingRow[13] || '',        // objection set by logConversion
        firstVisitDate || existingRow[14] || '',
        now
      ];
      await sheets.spreadsheets.values.update({
        spreadsheetId: BUSINESS_SHEET_ID,
        range: `marketing_funnel!A${rowIdx}:P${rowIdx}`,
        valueInputOption: 'RAW',
        requestBody: { values: [newRow] }
      });
    } else {
      // INSERT — new lead
      const newRow = [
        leadId,
        firstName || '',
        lastName || '',
        phone || '',
        sourcePipeline || '',
        now,           // first_call_date
        now,           // last_call_date
        '1',           // total_touchpoints
        currentStage || '',
        evalScheduled ? now : '',  // eval_scheduled_date
        evalHeld ? 'TRUE' : 'FALSE',
        'FALSE',       // post_eval_submitted
        '',            // conversion_outcome
        '',            // objection
        firstVisitDate || '',
        now
      ];
      await sheets.spreadsheets.values.append({
        spreadsheetId: BUSINESS_SHEET_ID,
        range: 'marketing_funnel!A:P',
        valueInputOption: 'RAW',
        requestBody: { values: [newRow] }
      });
    }
  } catch (err) {
    console.error('[upsertFunnelRow] failed:', err.message);
  }
}

// ============================================================
// markFunnelConversion — called from /post-eval handler
// Sets post_eval_submitted, conversion_outcome, objection
// on the funnel row. Doesn't create a new row if missing
// (post-eval should always follow at least one call event).
// ============================================================
async function markFunnelConversion({ leadId, outcome, objection }) {
  try {
    if (!leadId) {
      console.warn('[markFunnelConversion] skipped — no leadId');
      return;
    }
    const sheets = getSheetsClient();
    await ensureTab(sheets, 'marketing_funnel', FUNNEL_HEADERS);

    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: BUSINESS_SHEET_ID,
      range: 'marketing_funnel!A:P'
    }).catch(() => ({ data: { values: [] } }));
    const rows = existing.data.values || [];

    let rowIdx = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === leadId) {
        rowIdx = i + 1;
        break;
      }
    }
    if (rowIdx === -1) {
      console.warn(`[markFunnelConversion] no funnel row for lead_id ${leadId}`);
      return;
    }

    const now = new Date().toISOString();
    // Update only the conversion-related columns: L (post_eval_submitted),
    // M (conversion_outcome), N (objection), P (last_updated)
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: BUSINESS_SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: `marketing_funnel!L${rowIdx}`, values: [['TRUE']] },
          { range: `marketing_funnel!M${rowIdx}`, values: [[outcome || '']] },
          { range: `marketing_funnel!N${rowIdx}`, values: [[objection || '']] },
          { range: `marketing_funnel!P${rowIdx}`, values: [[now]] }
        ]
      }
    });
  } catch (err) {
    console.error('[markFunnelConversion] failed:', err.message);
  }
}

// ============================================================
// logConversion — append-only log of every post-eval submission
// ============================================================
async function logConversion({
  leadId, ptName, outcome, problem, treatmentPlan, objection, followUpDetails
}) {
  try {
    const sheets = getSheetsClient();
    await ensureTab(sheets, 'conversions', CONVERSIONS_HEADERS);

    const row = [
      new Date().toISOString(),
      leadId || '',
      ptName || '',
      outcome || '',
      problem || '',
      treatmentPlan || '',
      objection || '',
      followUpDetails || ''
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: BUSINESS_SHEET_ID,
      range: 'conversions!A:H',
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  } catch (err) {
    console.error('[logConversion] failed:', err.message);
  }
}

module.exports = {
  logCallEvent,
  upsertFunnelRow,
  markFunnelConversion,
  logConversion,
  PROMPT_VERSION,
  BUSINESS_SHEET_ID
};
