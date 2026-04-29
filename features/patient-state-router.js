/**
 * features/patient-state-router.js
 *
 * Patient-State-Aware Call Router
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * PURPOSE
 *   Intercepts inbound call/text webhooks BEFORE the lead pipeline classifier
 *   runs. If the contact has any open Customer Pipeline opportunity (i.e., they
 *   are not a true new lead), this router takes ownership of the call and
 *   prevents the lead pipeline from being touched at all.
 *
 *   The lead pipeline Claude classifier is for LEADS. Once a contact is in the
 *   Customer Pipeline (any stage), they are no longer a lead — they are a
 *   patient at some point in the conversion or care journey. Their interactions
 *   should be routed by patient state, not classified as lead-pipeline outcomes.
 *
 * THE THREE CONTACT STATES THIS ROUTER RECOGNIZES
 *   1. Lead              — no Customer Pipeline opp. Returns { handled: false }
 *                          and the orchestrator falls through to the lead flow.
 *   2. Pre-conversion    — Customer Pipeline opp at stages: Eval Scheduled,
 *                          Eval Held, any Pending stage, Not a Good Time. Stage-
 *                          aware Claude routing applies.
 *   3. Converted         — Package Purchased, Active Patient Special Circumstance,
 *                          Continuity Pipeline, or LTV > $500. Silent log only —
 *                          no Slack, both pipelines frozen.
 *
 * USAGE FROM index.js
 *   const { routePatientCall } = require('./features/patient-state-router');
 *   const result = await routePatientCall({ ctx, contact, allOpps, transcript, ... });
 *   if (result.handled) return; // router took ownership
 *   // otherwise fall through to existing lead flow
 *
 * WHY IT'S A FEATURE MODULE
 *   The orchestrator pattern (per webhook-architecture skill) — index.js stays
 *   an orchestrator, this file owns its domain end-to-end (state detection,
 *   Claude prompt, GHL writes, Slack messaging, task creation).
 */

'use strict';

const axios = require('axios');

// ─── Pipeline & Stage Constants ────────────────────────────────────────────────
// The router uses an explicit map of Customer Pipeline stage IDs so it does not
// depend on EVAL_CUSTOMER_STAGES from index.js. If you rename stages in GHL,
// update these IDs here. The companion script `scripts/list-ghl-pipelines.js`
// prints the current stage IDs from the GHL API.
const CUSTOMER_PIPELINE_ID = '0UnRjFIzcaUf35zXVXmT';
const CONTINUITY_PIPELINE_ID = 'UwFUs0w3nmj6k0f1EEXm';

const STAGES = {
  EVALUATION_SCHEDULED:           '5e8c01e5-7ffb-4308-b1a6-91602ad012da',
  EVALUATION_HELD:                '5d1f6b5e-93fa-480f-8d41-4fe4817c2e43',
  PENDING_VISIT:                  '6ff7cfd7-a308-4298-89ec-6855d7f383ff',
  PENDING_CALL_ATTEMPT_1:         '11bfcc99-c1c1-4936-8a04-73386796e1ea',
  PENDING_CALL_ATTEMPT_2:         '403e181d-86f3-48c8-954a-6795f292d522',
  PENDING_CALL_ATTEMPT_3:         '95f761ff-4e48-4cba-9796-7c41f290f0a3',
  PENDING_NO_FIRM_TIME:           'eb8828cb-98c5-4cdd-8510-56a174540a4e',
  PACKAGE_PURCHASED:              'cc3f6b52-846a-4bcc-9cd5-646ca5712ea1',
  ACTIVE_PATIENT_SPECIAL:         '52fb05ae-4af2-40dc-9264-68e42de8b3ed',
  NOT_GOOD_TIME:                  'f7ce8c60-7695-4da4-8c1b-5a030967647a',
  CLOSED_LOST:                    '5b13fe92-130a-4cd6-b9a5-eca5f8ff5729'
};

// Stages where the patient is fully converted — silent log only on inbound call/text
const CONVERTED_STAGES = new Set([
  STAGES.PACKAGE_PURCHASED,
  STAGES.ACTIVE_PATIENT_SPECIAL
]);

// Stages where patient-state-aware routing applies (pre-conversion)
const PRE_CONVERSION_STAGES = new Set([
  STAGES.EVALUATION_SCHEDULED,
  STAGES.EVALUATION_HELD,
  STAGES.PENDING_VISIT,
  STAGES.PENDING_CALL_ATTEMPT_1,
  STAGES.PENDING_CALL_ATTEMPT_2,
  STAGES.PENDING_CALL_ATTEMPT_3,
  STAGES.PENDING_NO_FIRM_TIME,
  STAGES.NOT_GOOD_TIME
]);

const STAGE_NAMES = {
  [STAGES.EVALUATION_SCHEDULED]:    'Evaluation Scheduled',
  [STAGES.EVALUATION_HELD]:         'Evaluation Held',
  [STAGES.PENDING_VISIT]:           'Pending - Follow Up Visit Booked',
  [STAGES.PENDING_CALL_ATTEMPT_1]:  'Pending - Follow Up Phone Call - Attempt 1',
  [STAGES.PENDING_CALL_ATTEMPT_2]:  'Pending - Follow Up Phone Call - Attempt 2',
  [STAGES.PENDING_CALL_ATTEMPT_3]:  'Pending - Follow Up Phone Call - Attempt 3',
  [STAGES.PENDING_NO_FIRM_TIME]:    'Pending - Needs Follow Up (No Firm Time)',
  [STAGES.PACKAGE_PURCHASED]:       'Package Purchased',
  [STAGES.ACTIVE_PATIENT_SPECIAL]:  'Active Patient - Special Circumstance',
  [STAGES.NOT_GOOD_TIME]:           'Not a Good Time - Needs Follow Up',
  [STAGES.CLOSED_LOST]:             'Closed/Lost'
};

// ─── Slack Channels & PT Map ───────────────────────────────────────────────────
const PIPELINE_MANAGER_CHANNEL = 'C0ASJSMT76Y';
const DEALS_BOARD_CHANNEL      = 'C0AU8CDTN4R';

const PT_SLACK_IDS = {
  'John Gan':         'U07TJC6GZFG',
  'TJ Aquino':        'U0A9DL4RTKN',
  'Chris Bostwick':   'U091NMDKTFV',
  'Shane Abbott':     'U07SAF0R2NQ',
  'Katy Vieira':      'U08REDY0146'
};

const SHANE_ID = PT_SLACK_IDS['Shane Abbott'];
const KATY_ID  = PT_SLACK_IDS['Katy Vieira'];

// ─── Claude Model & Constants ──────────────────────────────────────────────────
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const ADMIN_TASK_ASSIGNEE_EMAIL = 'info@movementclinicpt.com';
const LTV_CUSTOMER_THRESHOLD = 500;

// Objection categories must match the GHL dropdown exactly. If you add a new
// option to the dropdown in GHL, add it here too.
const OBJECTION_CATEGORIES = [
  'Too Expensive',
  'Wants to Explore In-Network Care',
  'Time Commitment',
  'Not the Right Time',
  'Needs to Talk to Spouse',
  'Needs to Think About It',
  "Business Hours Don't Work",
  'Cancelled Evaluation',
  'Other'
];

// ─── Helpers ───────────────────────────────────────────────────────────────────
function getTimestamp() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

function ptSlackTagsForCall(teamMember) {
  // Returns a comma-separated string of Slack mention tags. Always includes
  // Shane and Katy. Includes original PT (teamMember) if mappable.
  const tags = [];
  if (teamMember && PT_SLACK_IDS[teamMember]) {
    tags.push(`<@${PT_SLACK_IDS[teamMember]}>`);
  }
  // Avoid double-tagging Shane/Katy if they were the PT on call
  if (teamMember !== 'Shane Abbott') tags.push(`<@${SHANE_ID}>`);
  if (teamMember !== 'Katy Vieira')  tags.push(`<@${KATY_ID}>`);
  return tags.join(' ');
}

function getCurrentStageName(opp) {
  return STAGE_NAMES[opp.pipelineStageId] || opp.pipelineStageId;
}

function findCustomerPipelineOpp(allOpps) {
  return allOpps.find(o =>
    o.pipelineId === CUSTOMER_PIPELINE_ID && o.status === 'open'
  );
}

function findContinuityOpp(allOpps) {
  return allOpps.find(o =>
    o.pipelineId === CONTINUITY_PIPELINE_ID && o.status === 'open'
  );
}

// ─── Claude Prompt Builder ─────────────────────────────────────────────────────
function buildRouterPrompt(currentStageId, transcript, contactName) {
  const currentStageName = STAGE_NAMES[currentStageId] || 'Unknown';

  return `You are the patient-state-aware call router for Movement Clinic Physical Therapy, a cash-based PT clinic in Pasadena, CA.

You analyze a phone call transcript with an EXISTING patient (someone already in our Customer Pipeline) and decide what stage they should be in next, if any.

CONTACT
- Name: ${contactName}
- Current Customer Pipeline Stage: "${currentStageName}"

DECISION FRAMEWORK BY CURRENT STAGE

═══ EVALUATION SCHEDULED ═══
The patient already has a booked initial evaluation. They are calling about that booking.
- If they are confirming, asking logistics questions (parking, what to wear, what to bring, where to enter, prep), or rescheduling to a specific new date/time → action: LOG_ONLY
- If they are giving a SOFT cancel — life circumstances came up, want to follow up later, no firm timeframe, want to think about it more, financial timing concerns ("HSA not funded yet", "deductible resets soon") → action: SOFT_CANCEL_TO_NOT_GOOD_TIME (move to Not a Good Time - Needs Follow Up). For pure timing-based reasons unrelated to objections, prefer NOT_GOOD_TIME. For "no firm timeframe" softer signals, use action: SOFT_CANCEL_NO_FIRM_TIME.
- If they are giving a HARD cancel — going to in-network care, going to a competitor, decided not to do PT, definite no with no plan to return → action: HARD_CANCEL (move to Closed Lost)

═══ EVALUATION HELD ═══
The patient just held their evaluation. The transcript may be from a follow-up call or a callback after the eval where the next step is being decided.
- Patient committed to a package / wants to start a Plan of Care → action: COMMIT_TO_PACKAGE (move to Package Purchased)
- Patient agreed to come back for a follow-up VISIT (a treatment session before deciding) → action: SCHEDULED_FOLLOW_UP_VISIT (move to Pending - Follow Up Visit Booked)
- Patient agreed to a follow-up PHONE CALL on a specific date/time → action: SCHEDULED_FOLLOW_UP_CALL (move to Pending - Follow Up Phone Call - Attempt 1)
- Patient gave a soft objection with no firm timeframe ("get back to you in a few weeks", "let me think about it") → action: SOFT_CANCEL_NO_FIRM_TIME
- Patient gave a real-world timing blocker (HSA funding, deductible reset, financial timing) → action: SOFT_CANCEL_TO_NOT_GOOD_TIME
- Patient gave a hard cancel → action: HARD_CANCEL
- Outcome is genuinely unclear from the transcript → action: UNCLEAR (do not move stage, escalate to PT for clarification)

═══ PENDING - FOLLOW UP VISIT BOOKED ═══
The patient is between visits in their care journey but pre-package-purchase.
- If they are confirming or rescheduling the follow-up visit → action: LOG_ONLY
- If they committed to a package → action: COMMIT_TO_PACKAGE
- If they gave a soft cancel → action: SOFT_CANCEL_TO_NOT_GOOD_TIME or SOFT_CANCEL_NO_FIRM_TIME (per Eval Held rules)
- If they gave a hard cancel → action: HARD_CANCEL

═══ PENDING - FOLLOW UP PHONE CALL - ATTEMPT 1 / 2 / 3 ═══
The clinic is making outbound follow-up calls to a post-eval patient who hasn't yet decided.
- Patient committed to a package → action: COMMIT_TO_PACKAGE
- Patient gave a soft objection with no firm timeframe → action: SOFT_CANCEL_NO_FIRM_TIME
- Patient gave a real-world timing blocker → action: SOFT_CANCEL_TO_NOT_GOOD_TIME
- Patient gave a hard cancel → action: HARD_CANCEL
- No answer / voicemail / soft "call me back later" / no commitment → action: ADVANCE_PENDING (advance to next attempt; or if at Attempt 3, move to Closed Lost)
- Outcome unclear → action: UNCLEAR

═══ PENDING - NEEDS FOLLOW UP (NO FIRM TIME) ═══ and ═══ NOT A GOOD TIME - NEEDS FOLLOW UP ═══
The patient is parked here waiting to re-engage.
- Patient re-engages and commits to a package → action: COMMIT_TO_PACKAGE
- Patient hard cancels / changed their mind → action: HARD_CANCEL
- Anything else (still parked, still waiting, just checking in) → action: LOG_ONLY

═══ OBJECTION CATEGORY ═══
For any cancel or non-commit outcome, you MUST select one of these exact category strings (matches GHL dropdown):
${OBJECTION_CATEGORIES.map(c => '- ' + c).join('\n')}
For pre-eval cancels at Evaluation Scheduled, prefer "Cancelled Evaluation".

TRANSCRIPT
"""
${transcript}
"""

RETURN ONLY valid JSON with no other text, no preamble, no markdown:
{
  "action": "LOG_ONLY | COMMIT_TO_PACKAGE | SCHEDULED_FOLLOW_UP_VISIT | SCHEDULED_FOLLOW_UP_CALL | SOFT_CANCEL_NO_FIRM_TIME | SOFT_CANCEL_TO_NOT_GOOD_TIME | HARD_CANCEL | ADVANCE_PENDING | UNCLEAR",
  "objection_category": "exact value from list above, or null if not a cancel/non-commit",
  "objection_detail": "1-2 sentence specific reason from transcript, or null",
  "note": "2-4 sentence factual summary of the call",
  "extracted_name": "patient name if newly mentioned, or null",
  "follow_up_request": "if patient asked for outreach in a specific timeframe (e.g. '2 weeks', '1 month'), capture it here, otherwise null",
  "confidence_score": 85,
  "confidence_reason": "1 sentence on why this confidence level"
}`;
}

// ─── Claude API Call ───────────────────────────────────────────────────────────
async function analyzeWithRouterClaude(ctx, transcript, currentStageId, contactName) {
  const prompt = buildRouterPrompt(currentStageId, transcript, contactName);

  let response;
  try {
    response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: CLAUDE_MODEL,
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'x-api-key': ctx.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
  } catch (err) {
    console.error('[router] Claude API call failed:', err.response?.data || err.message);
    throw err;
  }

  const text = response.data.content?.[0]?.text || '';
  let parsed;
  try {
    // Strip code fences if Claude wrapped the JSON
    const cleaned = text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error('[router] Failed to parse Claude JSON. Raw text:', text);
    throw new Error('Router Claude returned invalid JSON');
  }

  return parsed;
}

// ─── Slack Block Builders ──────────────────────────────────────────────────────
function buildExistingPatientSummaryBlocks(args) {
  const { contactName, contactPhone, currentStageName, claudeResult, ghlUrl, headerText, headerEmoji, ptOnCall } = args;
  const score = parseInt(claudeResult.confidence_score) || 0;
  const confidenceEmoji = score >= 90 ? ':large_green_circle:' : score >= 80 ? ':large_yellow_circle:' : ':red_circle:';

  return [
    { type: 'header', text: { type: 'plain_text', text: `${headerEmoji} ${headerText}`, emoji: true } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${confidenceEmoji} *${score}% Confident in Transcript Interpretation*` }
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Patient*\n${contactName}` },
        { type: 'mrkdwn', text: `*Phone*\n${contactPhone}` },
        { type: 'mrkdwn', text: `*Current Stage*\n${currentStageName}` },
        { type: 'mrkdwn', text: `*PT on Call*\n${ptOnCall || 'Not identified'}` }
      ]
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Call Summary*\n${claudeResult.note || '_No summary_'}` }
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Open in GHL' }, url: ghlUrl }
      ]
    }
  ];
}

async function postSlack(ctx, channel, text, blocks) {
  if (!ctx.SLACK_BOT_TOKEN) {
    console.error('[router] SLACK_BOT_TOKEN not set — skipping Slack post');
    return;
  }
  try {
    await axios.post(
      'https://slack.com/api/chat.postMessage',
      { channel, text, blocks },
      {
        headers: {
          'Authorization': `Bearer ${ctx.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error('[router] Slack post failed:', err.response?.data || err.message);
  }
}

// ─── State Detection ───────────────────────────────────────────────────────────
async function detectContactState(ctx, contactId, allOpps) {
  // Returns one of: 'lead', 'pre_conversion', 'converted'
  // Plus the relevant Customer Pipeline opp (if any) and the detection reason.

  const customerOpp = findCustomerPipelineOpp(allOpps);
  const continuityOpp = findContinuityOpp(allOpps);

  // Converted: Continuity always wins
  if (continuityOpp) {
    return { state: 'converted', reason: 'continuity', opp: continuityOpp };
  }

  // Converted: Customer Pipeline at Package Purchased or Active Patient Special
  if (customerOpp && CONVERTED_STAGES.has(customerOpp.pipelineStageId)) {
    return { state: 'converted', reason: 'customer_converted_stage', opp: customerOpp };
  }

  // Pre-conversion: Customer Pipeline at any pre-conversion stage
  if (customerOpp && PRE_CONVERSION_STAGES.has(customerOpp.pipelineStageId)) {
    return { state: 'pre_conversion', reason: 'customer_pre_conversion_stage', opp: customerOpp };
  }

  // Customer Pipeline at Closed Lost or any other stage we don't recognize:
  // treat as converted (frozen) so we don't accidentally re-engage them as a lead.
  if (customerOpp) {
    return { state: 'converted', reason: 'customer_other_stage', opp: customerOpp };
  }

  // No Customer Pipeline opp — check LTV as a last-resort converted signal.
  // Note: ctx.getContactLTV is provided by index.js because the LTV lookup
  // depends on contact data already fetched there.
  try {
    const ltv = await ctx.getContactLTV(contactId);
    if (ltv > LTV_CUSTOMER_THRESHOLD) {
      return { state: 'converted', reason: 'ltv', opp: null, ltv };
    }
  } catch (err) {
    console.error('[router] getContactLTV failed (treating as lead):', err.message);
  }

  // True lead — let the orchestrator handle it
  return { state: 'lead' };
}

// ─── Action Handlers ───────────────────────────────────────────────────────────

async function writeContactNote(ctx, contactId, header, claudeResult, currentStageName) {
  const ts = getTimestamp();
  const lines = [
    'Claude AI Assistant:',
    '',
    `${header} — ${ts}`,
    '',
    `Current Stage: ${currentStageName}`,
    '',
    `Summary: ${claudeResult.note || 'No summary'}`
  ];
  if (claudeResult.objection_category) {
    lines.push('', `Objection Category: ${claudeResult.objection_category}`);
  }
  if (claudeResult.objection_detail) {
    lines.push(`Objection Detail: ${claudeResult.objection_detail}`);
  }
  if (claudeResult.follow_up_request) {
    lines.push('', `Follow-Up Request: ${claudeResult.follow_up_request}`);
  }
  await ctx.addNoteToContact(contactId, lines.join('\n'));
}

async function moveCustomerOpp(ctx, opportunityId, newStageId) {
  await ctx.updateGHLOpportunity(opportunityId, CUSTOMER_PIPELINE_ID, newStageId, null);
}

async function setObjectionFields(ctx, opportunityId, claudeResult) {
  if (!claudeResult.objection_category && !claudeResult.objection_detail) return;
  try {
    await ctx.updateOpportunityCustomFields(
      opportunityId,
      claudeResult.objection_category || null,
      claudeResult.objection_detail || null
    );
  } catch (err) {
    console.error('[router] Failed to write objection fields:', err.message);
  }
}

async function createAdminFollowUpTask(ctx, contactId, claudeResult, contactName) {
  // Used for soft-cancel-at-Evaluation-Scheduled cases where we want admin to
  // reach out later. Due date is based on Claude's follow_up_request if parseable,
  // otherwise defaults to 14 days out.
  let dueDate = new Date();
  let daysOut = 14;
  const fu = (claudeResult.follow_up_request || '').toLowerCase();
  const weekMatch = fu.match(/(\d+)\s*week/);
  const monthMatch = fu.match(/(\d+)\s*month/);
  const dayMatch = fu.match(/(\d+)\s*day/);
  if (weekMatch) daysOut = parseInt(weekMatch[1]) * 7;
  else if (monthMatch) daysOut = parseInt(monthMatch[1]) * 30;
  else if (dayMatch) daysOut = parseInt(dayMatch[1]);
  dueDate.setDate(dueDate.getDate() + daysOut);

  const title = `Follow up with ${contactName}: ${claudeResult.objection_category || 'Soft cancel'}`;
  try {
    // ctx.createGHLTask is the existing helper from index.js — already assigns to info@
    await ctx.createGHLTask(contactId, title, dueDate);
  } catch (err) {
    console.error('[router] Failed to create admin follow-up task:', err.message);
  }
}

// ─── Main Routing Logic for Pre-Conversion Patients ────────────────────────────
async function handlePreConversion(ctx, args) {
  const { contact, contactName, contactPhone, opp, transcript, teamMember, callerName } = args;
  const currentStageId = opp.pipelineStageId;
  const currentStageName = STAGE_NAMES[currentStageId] || currentStageId;
  const ghlUrl = `https://app.gohighlevel.com/v2/location/${ctx.GHL_LOCATION_ID}/contacts/detail/${contact.id}`;

  // 1. Run Claude
  const claudeResult = await analyzeWithRouterClaude(ctx, transcript, currentStageId, callerName || contactName);
  const action = claudeResult.action;
  console.log(`[router] Pre-conversion action: ${action} (stage: ${currentStageName})`);

  // 2. Dispatch by action
  switch (action) {
    case 'LOG_ONLY': {
      await writeContactNote(ctx, contact.id, '📞 Call Summary', claudeResult, currentStageName);
      // No Slack — silent log only
      break;
    }

    case 'COMMIT_TO_PACKAGE': {
      await moveCustomerOpp(ctx, opp.id, STAGES.PACKAGE_PURCHASED);
      await writeContactNote(ctx, contact.id, '🟢 Patient Committed to Package', claudeResult, currentStageName);
      const blocks = buildExistingPatientSummaryBlocks({
        contactName, contactPhone, currentStageName: 'Package Purchased',
        claudeResult, ghlUrl,
        headerText: 'Patient Committed to Package',
        headerEmoji: '🟢',
        ptOnCall: teamMember
      });
      await postSlack(ctx, PIPELINE_MANAGER_CHANNEL,
        `${contactName} committed to a package`, blocks);
      break;
    }

    case 'SCHEDULED_FOLLOW_UP_VISIT': {
      await moveCustomerOpp(ctx, opp.id, STAGES.PENDING_VISIT);
      await writeContactNote(ctx, contact.id, '📅 Follow-Up Visit Booked', claudeResult, currentStageName);
      // No Slack — internal stage progression
      break;
    }

    case 'SCHEDULED_FOLLOW_UP_CALL': {
      // From Eval Held only — drop into Attempt 1
      await moveCustomerOpp(ctx, opp.id, STAGES.PENDING_CALL_ATTEMPT_1);
      await writeContactNote(ctx, contact.id, '📞 Follow-Up Call Scheduled', claudeResult, currentStageName);
      // No Slack — internal stage progression
      break;
    }

    case 'SOFT_CANCEL_NO_FIRM_TIME': {
      await moveCustomerOpp(ctx, opp.id, STAGES.PENDING_NO_FIRM_TIME);
      await setObjectionFields(ctx, opp.id, claudeResult);
      await writeContactNote(ctx, contact.id, '🟡 Soft Cancel — No Firm Time', claudeResult, currentStageName);

      // Admin task: follow up later
      await createAdminFollowUpTask(ctx, contact.id, claudeResult, contactName);

      const blocks = buildExistingPatientSummaryBlocks({
        contactName, contactPhone,
        currentStageName: 'Pending - Needs Follow Up (No Firm Time)',
        claudeResult, ghlUrl,
        headerText: 'Soft Cancel — Patient Needs Follow Up Later',
        headerEmoji: '🟡',
        ptOnCall: teamMember
      });
      const tags = ptSlackTagsForCall(teamMember);
      await postSlack(ctx, PIPELINE_MANAGER_CHANNEL,
        `${tags} — Patient ${contactName} soft-cancelled, no firm timeframe`,
        blocks);
      break;
    }

    case 'SOFT_CANCEL_TO_NOT_GOOD_TIME': {
      await moveCustomerOpp(ctx, opp.id, STAGES.NOT_GOOD_TIME);
      await setObjectionFields(ctx, opp.id, claudeResult);
      await writeContactNote(ctx, contact.id, '🟡 Real-World Timing Blocker', claudeResult, currentStageName);

      // Admin task: follow up when timing improves
      await createAdminFollowUpTask(ctx, contact.id, claudeResult, contactName);

      const blocks = buildExistingPatientSummaryBlocks({
        contactName, contactPhone,
        currentStageName: 'Not a Good Time - Needs Follow Up',
        claudeResult, ghlUrl,
        headerText: 'Real-World Timing Blocker (HSA / Deductible / etc.)',
        headerEmoji: '🟡',
        ptOnCall: teamMember
      });
      const tags = ptSlackTagsForCall(teamMember);
      await postSlack(ctx, PIPELINE_MANAGER_CHANNEL,
        `${tags} — Patient ${contactName} flagged a timing blocker`,
        blocks);
      break;
    }

    case 'HARD_CANCEL': {
      await moveCustomerOpp(ctx, opp.id, STAGES.CLOSED_LOST);
      await setObjectionFields(ctx, opp.id, claudeResult);
      await writeContactNote(ctx, contact.id, '🔴 Patient Hard-Cancelled', claudeResult, currentStageName);

      const blocks = buildExistingPatientSummaryBlocks({
        contactName, contactPhone,
        currentStageName: 'Closed/Lost',
        claudeResult, ghlUrl,
        headerText: 'Patient Hard Cancel — Moved to Closed/Lost',
        headerEmoji: '🔴',
        ptOnCall: teamMember
      });
      const tags = ptSlackTagsForCall(teamMember);
      await postSlack(ctx, PIPELINE_MANAGER_CHANNEL,
        `${tags} — Patient ${contactName} hard cancelled`,
        blocks);
      break;
    }

    case 'ADVANCE_PENDING': {
      // Only valid when current stage is PENDING_CALL_ATTEMPT_1, _2, or _3
      const advanceMap = {
        [STAGES.PENDING_CALL_ATTEMPT_1]: STAGES.PENDING_CALL_ATTEMPT_2,
        [STAGES.PENDING_CALL_ATTEMPT_2]: STAGES.PENDING_CALL_ATTEMPT_3,
        [STAGES.PENDING_CALL_ATTEMPT_3]: STAGES.CLOSED_LOST
      };
      const nextStage = advanceMap[currentStageId];
      if (!nextStage) {
        console.warn(`[router] ADVANCE_PENDING but current stage is not a Pending Call stage. Falling back to LOG_ONLY.`);
        await writeContactNote(ctx, contact.id, '📞 Call Summary', claudeResult, currentStageName);
        break;
      }
      await moveCustomerOpp(ctx, opp.id, nextStage);
      const isFinal = nextStage === STAGES.CLOSED_LOST;
      if (isFinal) {
        await setObjectionFields(ctx, opp.id, claudeResult);
        await writeContactNote(ctx, contact.id, '🔴 Pending Call Attempt 3 — Moved to Closed/Lost', claudeResult, currentStageName);
        const blocks = buildExistingPatientSummaryBlocks({
          contactName, contactPhone,
          currentStageName: 'Closed/Lost',
          claudeResult, ghlUrl,
          headerText: 'No Response After 3 Attempts — Closed/Lost',
          headerEmoji: '🔴',
          ptOnCall: teamMember
        });
        const tags = ptSlackTagsForCall(teamMember);
        await postSlack(ctx, PIPELINE_MANAGER_CHANNEL,
          `${tags} — ${contactName} did not respond after 3 attempts, moved to Closed/Lost`,
          blocks);
      } else {
        await writeContactNote(ctx, contact.id, `📞 Advanced to ${STAGE_NAMES[nextStage]}`, claudeResult, currentStageName);
        // No Slack on intermediate advancement — silent
      }
      break;
    }

    case 'UNCLEAR': {
      // Don't move stage. Slack to deals-board tagging the eval PT for clarification.
      await writeContactNote(ctx, contact.id, '🟡 Unclear Outcome — PT Input Needed', claudeResult, currentStageName);
      const blocks = buildExistingPatientSummaryBlocks({
        contactName, contactPhone, currentStageName,
        claudeResult, ghlUrl,
        headerText: 'Unclear Outcome — PT Input Needed',
        headerEmoji: '🟡',
        ptOnCall: teamMember
      });
      const tags = ptSlackTagsForCall(teamMember);
      await postSlack(ctx, DEALS_BOARD_CHANNEL,
        `${tags} — ${contactName} call outcome unclear, please review`,
        blocks);
      break;
    }

    default: {
      console.warn(`[router] Unknown action "${action}" — falling back to LOG_ONLY behavior`);
      await writeContactNote(ctx, contact.id, '📞 Call Summary', claudeResult, currentStageName);
    }
  }

  // GHL summary webhook — keeps the email log working for converted/pre-conversion alike
  try {
    await ctx.fireGHLSummaryWebhook({
      contact_name: contactName || 'Unknown',
      contact_phone: contactPhone || 'Unknown',
      contact_id: contact.id,
      outcome: `PRE-CONVERSION (${currentStageName}) → ${action}`,
      call_summary: claudeResult.note || '',
      pipeline_stage_info: `Customer Pipeline — was: ${currentStageName}`,
      pipeline_name: 'Customer Pipeline',
      previous_stage: currentStageName,
      new_stage: action,
      stage_changed: action === 'LOG_ONLY' || action === 'UNCLEAR' ? 'No' : 'Yes',
      opportunity_value_previous: 'N/A', opportunity_value_new: 'N/A',
      note_added: 'Yes',
      new_contact_created: 'No',
      new_opportunity_created: 'No',
      name_extracted_from_transcript: claudeResult.extracted_name || 'No',
      disqualifier_flag: 'None',
      follow_up_task_created: (action === 'SOFT_CANCEL_NO_FIRM_TIME' || action === 'SOFT_CANCEL_TO_NOT_GOOD_TIME') ? 'Yes' : 'No',
      follow_up_days: claudeResult.follow_up_request || 'None'
    });
  } catch (err) {
    console.error('[router] fireGHLSummaryWebhook failed (non-blocking):', err.message);
  }

  return { handled: true, action };
}

// ─── Main Routing Logic for Converted Patients ─────────────────────────────────
async function handleConverted(ctx, args) {
  const { contact, contactName, contactPhone, opp, reason, transcript, callerName } = args;
  const currentStageName = opp ? (STAGE_NAMES[opp.pipelineStageId] || opp.pipelineStageId) : `LTV > $${LTV_CUSTOMER_THRESHOLD}`;
  console.log(`[router] Converted patient (reason: ${reason}, stage: ${currentStageName})`);

  // Run Claude for full context — written to contact note only, no Slack
  let claudeResult;
  try {
    // Use a stable, recognized stage name for the prompt context. If the contact
    // is LTV-only with no opp, frame the prompt as Package Purchased.
    const stageForPrompt = opp ? opp.pipelineStageId : STAGES.PACKAGE_PURCHASED;
    claudeResult = await analyzeWithRouterClaude(ctx, transcript, stageForPrompt, callerName || contactName);
  } catch (err) {
    console.error('[router] Converted-patient Claude analysis failed:', err.message);
    claudeResult = { note: '(Claude analysis failed — see transcript in source system)', action: 'LOG_ONLY' };
  }

  await writeContactNote(ctx, contact.id, '📞 Patient Touchpoint', claudeResult, currentStageName);

  // GHL summary webhook so the email log still captures the call
  try {
    await ctx.fireGHLSummaryWebhook({
      contact_name: contactName || 'Unknown',
      contact_phone: contactPhone || 'Unknown',
      contact_id: contact.id,
      outcome: `CONVERTED PATIENT — Touchpoint Logged (${reason})`,
      call_summary: claudeResult.note || '',
      pipeline_stage_info: `Frozen — converted patient at ${currentStageName}`,
      pipeline_name: 'Customer Pipeline',
      previous_stage: currentStageName, new_stage: currentStageName,
      stage_changed: 'No',
      opportunity_value_previous: 'N/A', opportunity_value_new: 'N/A',
      note_added: 'Yes', new_contact_created: 'No', new_opportunity_created: 'No',
      name_extracted_from_transcript: claudeResult.extracted_name || 'No',
      disqualifier_flag: 'None', follow_up_task_created: 'No', follow_up_days: 'None'
    });
  } catch (err) {
    console.error('[router] fireGHLSummaryWebhook failed (non-blocking):', err.message);
  }

  return { handled: true, action: 'CONVERTED_LOG_ONLY' };
}

// ─── PUBLIC ENTRYPOINT ─────────────────────────────────────────────────────────
/**
 * Routes an inbound call/text webhook based on the contact's patient state.
 *
 * @param {object} args
 * @param {object} args.ctx                 - Context object exposing helpers and env from index.js.
 *                                            Must include: GHL_API_KEY, GHL_LOCATION_ID, ANTHROPIC_API_KEY,
 *                                            SLACK_BOT_TOKEN, addNoteToContact, updateGHLOpportunity,
 *                                            updateOpportunityCustomFields, getContactLTV,
 *                                            createGHLTask, fireGHLSummaryWebhook
 * @param {object} args.contact             - GHL contact object (must have .id)
 * @param {object[]} args.allOpps           - All opportunities for this contact
 * @param {string} args.transcript          - Full call transcript
 * @param {string} args.contactPhone        - Redacted phone string for display
 * @param {string} args.teamMember          - PT name from QUO_USER_MAP, e.g. "Katy Vieira"
 * @param {string} args.callId              - Quo call ID, for logging
 * @param {string} args.callerName          - Display name (e.g. "M.Z." or "Mary Z.")
 *
 * @returns {Promise<{handled: boolean, action?: string, reason?: string}>}
 *   - { handled: true, action }            - Router took ownership; orchestrator should return
 *   - { handled: false, reason }           - True lead; orchestrator should continue
 */
async function routePatientCall(args) {
  const { ctx, contact, allOpps, transcript, contactPhone, teamMember, callerName } = args;

  if (!contact || !contact.id) {
    console.error('[router] No contact passed in — cannot route');
    return { handled: false, reason: 'no_contact' };
  }
  if (!Array.isArray(allOpps)) {
    console.error('[router] allOpps not an array — treating as lead');
    return { handled: false, reason: 'no_opps_data' };
  }

  // Derive a clean display name from the contact
  const contactName = (callerName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || 'Unknown');

  let stateInfo;
  try {
    stateInfo = await detectContactState(ctx, contact.id, allOpps);
  } catch (err) {
    console.error('[router] detectContactState failed — falling through to lead flow:', err.message);
    return { handled: false, reason: 'detect_failed' };
  }

  console.log(`[router] Contact state: ${stateInfo.state} (reason: ${stateInfo.reason || 'n/a'})`);

  if (stateInfo.state === 'lead') {
    return { handled: false, reason: 'true_lead' };
  }

  if (stateInfo.state === 'converted') {
    return await handleConverted(ctx, {
      contact, contactName, contactPhone,
      opp: stateInfo.opp,
      reason: stateInfo.reason,
      transcript, callerName
    });
  }

  // pre_conversion
  return await handlePreConversion(ctx, {
    contact, contactName, contactPhone,
    opp: stateInfo.opp,
    transcript, teamMember, callerName
  });
}

// ─── Defense-in-Depth Guard for index.js ───────────────────────────────────────
/**
 * Returns true if a lead opportunity should NOT be created for this contact
 * because they have an open Customer Pipeline opportunity at any stage.
 *
 * Use this as a final guard immediately before createGHLOpportunity in index.js.
 *
 * @param {object[]} allOpps
 * @returns {{ shouldBlock: boolean, reason?: string, customerOppId?: string }}
 */
function shouldBlockLeadOppCreation(allOpps) {
  if (!Array.isArray(allOpps)) return { shouldBlock: false };
  const customerOpp = findCustomerPipelineOpp(allOpps);
  if (customerOpp) {
    return {
      shouldBlock: true,
      reason: `open_customer_pipeline_opp_at_${STAGE_NAMES[customerOpp.pipelineStageId] || customerOpp.pipelineStageId}`,
      customerOppId: customerOpp.id
    };
  }
  const continuityOpp = findContinuityOpp(allOpps);
  if (continuityOpp) {
    return {
      shouldBlock: true,
      reason: 'open_continuity_pipeline_opp',
      customerOppId: continuityOpp.id
    };
  }
  return { shouldBlock: false };
}

module.exports = {
  routePatientCall,
  shouldBlockLeadOppCreation,
  // Exported for testing / debugging
  detectContactState,
  STAGES,
  STAGE_NAMES,
  CUSTOMER_PIPELINE_ID
};
