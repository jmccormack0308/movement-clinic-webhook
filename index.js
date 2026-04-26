require('dotenv').config();
const { Client } = require('@notionhq/client');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const https = require('https');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GMAIL_USER = process.env.GMAIL_USER;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SERVICE_ACCOUNT_JSON = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const BRIEFING_SEND_TIME = process.env.BRIEFING_SEND_TIME || '0 14 * * *';
const WEBHOOK_SERVER_URL = process.env.WEBHOOK_SERVER_URL; // e.g. https://your-webhook.railway.app
const BRIEFING_PIN = process.env.BRIEFING_PIN || '2365';

// Recurring items log — stored as JSON string in env var RECURRING_LOG
// Format: { "notionId_or_messageId": "YYYY-MM-DD" }
function getRecurringLog() {
  try {
    return JSON.parse(process.env.RECURRING_LOG || '{}');
  } catch { return {}; }
}


// ─── SERVICE HEARTBEAT ────────────────────────────────────────────────────────
// Writes to Service_Health tab in the Business Finance sheet every 5 min.
// Auto-creates the tab on first heartbeat. No new env vars needed.
const BUSINESS_SHEET_ID = '1tQmCNgqdQg_ijSpxYfC6iD4J4NfFhSiz2krpeU0xAG4';
const SERVICE_NAME = 'Daily-Briefing';

let healthTabReady = false;
let lastHeartbeatStatus = 'Not yet sent';
let lastHeartbeatTime = null;

async function ensureHealthTab(sheets) {
  if (healthTabReady) return;
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: BUSINESS_SHEET_ID });
    const exists = meta.data.sheets.some(s => s.properties.title === 'Service_Health');
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: BUSINESS_SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'Service_Health' } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: BUSINESS_SHEET_ID,
        range: 'Service_Health!A1:D1',
        valueInputOption: 'RAW',
        requestBody: { values: [['Service Name', 'Last Heartbeat', 'Status', 'URL']] },
      });
    }
    healthTabReady = true;
  } catch (err) {
    console.error('[ensureHealthTab]', err.message);
  }
}

async function writeHeartbeat(statusMessage = 'OK') {
  try {
    const auth = new google.auth.JWT({
      email: SERVICE_ACCOUNT_JSON.client_email,
      key: SERVICE_ACCOUNT_JSON.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    await ensureHealthTab(sheets);

    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: BUSINESS_SHEET_ID,
      range: 'Service_Health!A:D',
    }).catch(() => ({ data: { values: [] } }));
    const rows = existing.data.values || [];
    const now = new Date().toISOString();
    let updated = false;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === SERVICE_NAME) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: BUSINESS_SHEET_ID,
          range: `Service_Health!A${i+1}:D${i+1}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[SERVICE_NAME, now, statusMessage, process.env.RAILWAY_STATIC_URL || '']] },
        });
        updated = true;
        break;
      }
    }
    if (!updated) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: BUSINESS_SHEET_ID,
        range: 'Service_Health!A:D',
        valueInputOption: 'RAW',
        requestBody: { values: [[SERVICE_NAME, now, statusMessage, process.env.RAILWAY_STATIC_URL || '']] },
      });
    }
    lastHeartbeatStatus = statusMessage;
    lastHeartbeatTime = now;
  } catch (err) {
    console.error('[heartbeat]', err.message);
    lastHeartbeatStatus = 'ERROR: ' + err.message.slice(0, 60);
  }
}

// Fire on startup + every 5 minutes
setTimeout(() => writeHeartbeat('Started'), 5000);
setInterval(() => writeHeartbeat('OK'), 5 * 60 * 1000);

// ─── NOTION ───────────────────────────────────────────────────────────────────
async function getNotionTasks() {
  const notion = new Client({ auth: NOTION_TOKEN });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString().split('T')[0];

  const sevenDaysOut = new Date(today);
  sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);
  const sevenDaysISO = sevenDaysOut.toISOString().split('T')[0];

  const twentyOneDaysOut = new Date(today);
  twentyOneDaysOut.setDate(twentyOneDaysOut.getDate() + 21);
  const twentyOneDaysISO = twentyOneDaysOut.toISOString().split('T')[0];

  const fourteenDaysOut = new Date(today);
  fourteenDaysOut.setDate(fourteenDaysOut.getDate() + 14);
  const fourteenDaysISO = fourteenDaysOut.toISOString().split('T')[0];

  const ninetyDaysAgo = new Date(today);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const ninetyDaysAgoISO = ninetyDaysAgo.toISOString().split('T')[0];

  // Jan 1 2025 cutoff — ignore anything created before this
  const cutoffISO = '2025-01-01';

  // Single query — only filter is Done = false. No date filtering at all.
  const response = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: { property: 'Done', checkbox: { equals: false } },
    sorts: [
      { property: 'Due Date', direction: 'ascending' },
      { timestamp: 'created_time', direction: 'descending' },
    ],
    page_size: 100,
  });

  const recurringLog = getRecurringLog();

  const tasks = response.results
    .map(page => {
      const props = page.properties;

      const titleProp = Object.values(props).find(p => p.type === 'title');
      const title = titleProp?.title?.map(t => t.plain_text).join('') || 'Untitled';

      const dueDateProp = props['Due Date'];
      const dueDate = dueDateProp?.date?.start || null;

      const createdDate = page.created_time ? page.created_time.split('T')[0] : null;

      // Skip tasks created before Jan 1 2025
      if (createdDate && createdDate < cutoffISO) return null;

      const importanceProp = props['Importance'];
      const importance = importanceProp?.select?.name || null;

      const statusProp = props['Status'];
      const status = statusProp?.status?.name || null;

      const isStale = !dueDate && createdDate && createdDate < ninetyDaysAgoISO;

      // Check if this task recurred from a previous briefing
      const lastSeen = recurringLog[page.id] || null;
      const isRecurring = lastSeen && lastSeen !== todayISO;

      const url = `https://www.notion.so/${page.id.replace(/-/g, '')}`;

      return { title, dueDate, createdDate, importance, status, isStale, isRecurring, lastSeen, url, id: page.id };
    })
    .filter(Boolean); // Remove null (pre-2025) tasks

  const todayTasks = tasks.filter(t => t.dueDate === todayISO);
  const upcomingTasks = tasks.filter(t => t.dueDate && t.dueDate > todayISO && t.dueDate <= twentyOneDaysISO);
  const overdueTasks = tasks.filter(t => t.dueDate && t.dueDate < todayISO);
  const noDueDateTasks = tasks.filter(t => !t.dueDate && !t.isStale);
  const staleTasks = tasks.filter(t => t.isStale);

  return { todayTasks, upcomingTasks, overdueTasks, noDueDateTasks, staleTasks, allTasks: tasks };
}
// ─── NOTION EVENTS CALENDAR ───────────────────────────────────────────────────
const NOTION_EVENTS_DB_ID = '166e3256aaa180fba711cec33309973c';

async function getNotionEvents() {
  const notion = new Client({ auth: NOTION_TOKEN });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString().split('T')[0];
  const twentyOneDaysOut = new Date(today);
  twentyOneDaysOut.setDate(twentyOneDaysOut.getDate() + 21);
  const twentyOneDaysISO = twentyOneDaysOut.toISOString().split('T')[0];

  try {
    const response = await notion.databases.query({
      database_id: NOTION_EVENTS_DB_ID,
      filter: {
        and: [
          {
            or: [
              { property: 'Date', date: { on_or_after: todayISO } },
              { property: 'Date', date: { is_empty: true } },
            ]
          },
          { property: 'Date', date: { on_or_before: twentyOneDaysISO } },
        ]
      },
      sorts: [{ property: 'Date', direction: 'ascending' }],
      page_size: 20,
    });

    return response.results.map(page => {
      const props = page.properties;
      const titleProp = Object.values(props).find(p => p.type === 'title');
      const title = titleProp?.title?.map(t => t.plain_text).join('') || 'Untitled Event';
      const dateProp = props['Date'] || props['date'] || props['Event Date'] || props['Start'];
      const eventDate = dateProp?.date?.start || null;
      const url = `https://www.notion.so/${page.id.replace(/-/g, '')}`;
      return { title, eventDate, url };
    }).filter(e => e.eventDate);
  } catch (err) {
    console.error('Events calendar fetch failed:', err.message);
    return [];
  }
}



// ─── GMAIL ────────────────────────────────────────────────────────────────────
async function getGmailAuth() {
  const auth = new google.auth.JWT({
    email: SERVICE_ACCOUNT_JSON.client_email,
    key: SERVICE_ACCOUNT_JSON.private_key,
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
    subject: GMAIL_USER,
  });
  await auth.authorize();
  return auth;
}

async function getInboxEmails() {
  const auth = await getGmailAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  // Fetch two buckets and merge:
  // 1. Unread inbox (last 20) — catches new emails
  // 2. Inbox messages from real people in last 90 days with no reply — catches ignored emails
  const [unreadRes, oldRes] = await Promise.all([
    gmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX', 'UNREAD'],
      maxResults: 20,
    }),
    gmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX'],
      q: 'newer_than:90d -label:sent -from:me -category:promotions -category:updates -category:social -category:forums',
      maxResults: 30,
    }),
  ]);

  // Merge and deduplicate by message id
  const allMessages = [...(unreadRes.data.messages || []), ...(oldRes.data.messages || [])];
  const seen = new Set();
  const messages = allMessages.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  if (messages.length === 0) return [];

  const emails = await Promise.all(messages.map(async msg => {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });

    const headers = detail.data.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
    const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
    const date = headers.find(h => h.name === 'Date')?.value || '';
    const snippet = detail.data.snippet || '';
    const isUnread = (detail.data.labelIds || []).includes('UNREAD');
    const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${msg.id}`;

    return { id: msg.id, subject, from, date, snippet, isUnread, gmailUrl };
  }));

  return emails;
}

// ─── CLAUDE ANALYSIS ──────────────────────────────────────────────────────────
async function analyzeWithClaude(notionData, emails, events = []) {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const recurringLog = getRecurringLog();
  const todayISO = new Date().toISOString().split('T')[0];

  const slimTask = t => ({
    t: t.title,
    d: t.dueDate,
    c: t.createdDate,
    i: t.importance,
    u: t.url,
    id: t.id,
    recurring: t.isRecurring ? `Appeared in previous briefing on ${t.lastSeen}` : null,
  });

  const slimEmail = e => ({
    f: e.from.slice(0, 60),
    s: e.subject.slice(0, 100),
    n: e.snippet.slice(0, 200),
    u: e.gmailUrl,
    id: e.id,
    recurring: recurringLog[e.id] && recurringLog[e.id] !== todayISO
      ? `Appeared in previous briefing on ${recurringLog[e.id]}` : null,
  });

  // Ordered overdue first so highest-priority tasks survive if output is ever truncated.
  // No-due-date and stale sorted newest-created-first since most tasks lack due dates.
  const sortByDueAsc = (a, b) => (a.dueDate || '').localeCompare(b.dueDate || '');
  const sortByCreatedDesc = (a, b) => (b.createdDate || '').localeCompare(a.createdDate || '');

  const taskSummary = JSON.stringify({
    overdue: [...notionData.overdueTasks].sort(sortByDueAsc).map(slimTask),
    today: notionData.todayTasks.map(slimTask),
    upcoming: [...notionData.upcomingTasks].sort(sortByDueAsc).map(slimTask),
    noDueDate: [...notionData.noDueDateTasks].sort(sortByCreatedDesc).map(slimTask),
    stale: [...notionData.staleTasks].sort(sortByCreatedDesc).map(slimTask),
  });

  const emailSummary = JSON.stringify(emails.slice(0, 15).map(slimEmail));
  const eventsSummary = JSON.stringify(events.slice(0, 15).map(e => ({
    title: e.title,
    date: e.eventDate,
    url: e.url,
  })));

  const prompt = `You are a daily briefing assistant for Jordan McCormack, owner of Movement Clinic Physical Therapy (cash-based PT clinic in Pasadena, CA). Jordan also does contract PT at SpaceX and is involved in space medicine through Minerva.

Produce a structured daily briefing. Be direct and actionable. Jordan is busy and does not want fluff.

NOTION TASKS (incomplete, created 2025 or later):
${taskSummary}

UPCOMING EVENTS & MARKETING MILESTONES (next 21 days, from Notion events/projects tracker — these are clinic events, marketing campaigns, workshops, partnerships, and deadlines, NOT patient appointments):
${eventsSummary}

UNREAD INBOX EMAILS:
${emailSummary}

Return ONLY valid JSON in this exact format:
{
  "priority_actions_today": [
    {
      "type": "task or email",
      "title": "clear action description",
      "why": "one sentence on urgency",
      "url": "link",
      "notion_id": "notion page id if task, null if email",
      "message_id": "gmail message id if email, null if task",
      "suggested_action": "what to do",
      "recurring_flag": "🔁 Still pending from [date] or null"
    }
  ],
  "upcoming_deadlines": [
    { "title": "task name", "due_date": "date", "url": "notion link", "notion_id": "id" }
  ],
  "no_due_date_tasks": [
    { "title": "task name", "created_date": "date", "url": "notion link", "notion_id": "notion page id — always include" }
  ],
  "emails_needing_response": [
    {
      "from": "sender",
      "subject": "subject",
      "summary": "one sentence",
      "suggested_action": "reply yourself / forward to admin",
      "url": "gmail link",
      "message_id": "gmail message id",
      "ambiguous": true or false,
      "draft_label_yes": "3-4 word affirmative label if ambiguous",
      "draft_label_no": "3-4 word declining label if ambiguous",
      "recurring_flag": "🔁 Still pending from [date] or null"
    }
  ],
  "delegate_to_admin": [
    {
      "type": "task or email",
      "title": "what to delegate",
      "url": "link",
      "notion_id": "notion page id if task, null if email",
      "message_id": "gmail message id if email, null if task",
      "reason": "one sentence why this belongs with admin",
      "contact_name": "full name of related patient/contact if applicable, null if not patient-related",
      "contact_phone": "phone number of related contact if available, null if not",
      "suggested_notes": "2-3 sentences Claude drafts as suggested instructions for the admin — be specific and actionable"
    }
  ],
  "overdue_items": [
    { "title": "task name", "due_date": "date", "url": "notion link", "notion_id": "notion page id — always include this", "recurring_flag": "🔁 or null" }
  ],
  "stale_tasks": [
    { "title": "task name", "created_date": "date", "url": "notion link", "notion_id": "notion page id — always include this", "recommendation": "still relevant or archive?" }
  ],
  "calendar_events": [
    { "title": "event name", "date": "YYYY-MM-DD", "url": "notion link", "description": "one line context if relevant" }
  ],
  "no_action_needed": ["email subjects only — purely informational or filtered out"]
}

EMAIL FILTERING RULES:
EMAIL ROUTING — route each email to exactly one bucket:

emails_needing_response — Jordan personally replies:
- Any email from a real person that appears to need a reply (patient, lead, collaborator, partner, hiring candidate, referral, vendor relationship)
- Emails about scheduling, appointments, partnerships, events, or clinical matters
- Any email that has gone unresponded to from a real person, even if weeks old
- Indeed [Action Required] or any job applicant who wrote personally
- Anything with urgent, invoice, contract, legal, or time-sensitive language from a real sender
- Emails from schools, sports teams, fitness businesses, or community orgs about PT or collaboration
- WHEN IN DOUBT about whether a real person sent it and it might need a reply — include it here

delegate_to_admin — real emails but Jordan doesn't need to handle personally:
- Interview scheduling, admin coordination, routine vendor communication
- Emails clearly addressed to the clinic generally rather than Jordan specifically
- Follow-ups on things admin can handle (scheduling, basic info requests)

no_action_needed — automated or purely informational, no reply needed:
- Emails from noreply@, no-reply@, donotreply@, or @rehabceos.com
- GHL/CRM system notifications: "Has Replied", "Running Analysis", "New Lead", "Appointment Booked", "Pipeline Update", "Workflow", "Call Scheduled", "Form Submitted", "Contact Created"
- Social media notifications (Instagram, Facebook, LinkedIn activity alerts)
- Ad platform automated reports (Google Ads, Meta Ads)
- Newsletters, marketing blasts, promotional emails, subscription digests
- Automated receipts and shipping confirmations from known recurring vendors
- Retail, clothing, gear, supplement, or lifestyle product emails
- Calendar invite confirmations from scheduling tools (Calendly, Acuity)
- Subjects starting with "Introducing", "New Arrivals", "Shop Now", "Save Now", "Don't Miss"

DEFAULT RULE: If unsure whether an email needs a reply, put it in emails_needing_response rather than excluding it. Jordan would rather see a slightly irrelevant email than miss something important.

TASK RULES:
CRITICAL: You MUST include every single task from the input in one of these buckets. Do not drop, skip, or omit any task. Every task in the input must appear somewhere in the output JSON.
- upcoming_deadlines: ALL tasks that have a future due date — include every single one, not just the important ones
- overdue_items: ALL tasks with a past due date — include every single one
- no_due_date_tasks: ALL tasks with no due date that are NOT stale — include every single one
- stale_tasks: tasks with no due date created 90+ days ago
- priority_actions_today: tasks due today OR overdue items that need immediate action — these can also appear in overdue_items/upcoming_deadlines (cross-list is fine)
- delegate_to_admin: tasks that are clearly admin work — also include in no_due_date_tasks or upcoming_deadlines as appropriate
- Flag recurring items with the recurring_flag field
- Never drop a task just because it seems less important — Jordan wants to see everything`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;
  const clean = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (err) {
    console.error('Claude response malformed. Length:', clean.length);
    console.error('Last 300 chars:', clean.slice(-300));

    // Graceful fallback — attempt to salvage whatever completed sections Claude returned.
    // Tasks were sent ordered overdue → today → upcoming → no-date → stale,
    // so highest-priority items appear first in any truncated output.
    console.error('⚠️ Attempting partial JSON salvage...');
    try {
      const salvaged = clean
        .replace(/,?\s*\{[^}]*$/, '')
        .replace(/,?\s*$/, '') + ']}';
      const partial = JSON.parse(salvaged);
      partial._partial = true;
      console.error('⚠️ Partial salvage succeeded — briefing will show available sections only.');
      return partial;
    } catch {
      console.error('⚠️ Salvage failed — returning safe skeleton.');
      return {
        _partial: true,
        priority_actions_today: [],
        upcoming_deadlines: [],
        no_due_date_tasks: [],
        emails_needing_response: [],
        delegate_to_admin: [],
        overdue_items: [],
        stale_tasks: [],
        calendar_events: [],
        no_action_needed: [],
        _error: 'Claude response truncated. Increase max_tokens or reduce input.',
      };
    }
  }
}

// ─── DRAFT TEXT GENERATION ────────────────────────────────────────────────────
// Generates draft text stored in briefing payload for mailto: links.
// No Gmail API calls needed — one tap on mobile opens the mail app with everything pre-filled.
async function generateDraftTexts(emailsNeedingResponse, allEmails) {
  if (!emailsNeedingResponse?.length) return {};

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const draftTexts = {};

  for (const emailMeta of emailsNeedingResponse) {
    const original = allEmails.find(a => a.gmailUrl === emailMeta.url);
    const snippet = (original?.snippet || emailMeta.summary).replace(/[\x00-\x1F\x7F]/g, ' ').trim();
    const subject = emailMeta.subject?.startsWith('Re:') ? emailMeta.subject : `Re: ${emailMeta.subject || ''}`;

    // Extract plain email address from "Name <email@domain.com>" format
    const fromRaw = emailMeta.from || '';
    const toMatch = fromRaw.match(/<([^>]+)>/) || fromRaw.match(/([\w.+-]+@[\w.-]+)/);
    const toAddress = toMatch ? toMatch[1] : fromRaw;

    const prompt = `Write an email reply for Jordan McCormack, owner of Movement Clinic Physical Therapy in Pasadena, CA. Jordan also does contract PT at SpaceX and is involved in space medicine through Minerva.

JORDAN'S WRITING STYLE:
- Direct and warm, leans slightly formal but not stiff
- Short paragraphs, gets to the point quickly
- No corporate clichés ("circle back", "touch base", "put a pin in it", "per my last email", "going forward", "moving the needle", "hope this finds you well", "as per", "synergy", "leverage")
- No em dashes
- No AI-sounding or overly polished language
- Sounds like a real, busy person who is genuinely engaged
- Sign off: "Best,\nJordan"

EMAIL TO REPLY TO:
From: ${fromRaw}
Subject: ${emailMeta.subject}
Content: ${snippet}

${emailMeta.ambiguous ? `This requires a decision. Write TWO options:
- Option A (${emailMeta.draft_label_yes}): affirmative/accepting
- Option B (${emailMeta.draft_label_no}): declining/deferring

Return ONLY this JSON (no markdown):
{"ambiguous":true,"draft_yes":"full body text","draft_no":"full body text"}` :
`Write ONE clear reply.
Return ONLY this JSON (no markdown):
{"ambiguous":false,"single_draft":"full body text"}`}

Body only — start with greeting, end with "Best,\nJordan". No subject lines.`;

    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0].text.replace(/```json|```/g, '').trim();
      const draft = JSON.parse(text);

      if (!draft.ambiguous && draft.single_draft) {
        draftTexts[emailMeta.message_id] = {
          type: 'single',
          to: toAddress,
          subject,
          body: draft.single_draft,
        };
      } else if (draft.ambiguous) {
        draftTexts[emailMeta.message_id] = {
          type: 'ambiguous',
          to: toAddress,
          subject,
          bodyYes: draft.draft_yes || '',
          bodyNo: draft.draft_no || '',
          labelYes: emailMeta.draft_label_yes || 'Yes',
          labelNo: emailMeta.draft_label_no || 'Decline',
        };
      }

      console.log(`   ✏️ Draft text generated: ${emailMeta.subject}`);
    } catch (err) {
      console.error(`   Draft text failed for "${emailMeta.subject}":`, err.message);
    }
  }

  return draftTexts;
}

// ─── POST TO WEBHOOK SERVER ───────────────────────────────────────────────────
async function postBriefingToServer(analysis, draftTexts, notionData, emailCount) {
  const payload = JSON.stringify({
    date: new Date().toISOString(),
    analysis,
    draftTexts,
    taskCounts: {
      today: notionData.todayTasks.length,
      overdue: notionData.overdueTasks.length,
      upcoming: notionData.upcomingTasks.length,
      stale: notionData.staleTasks.length,
    },
    emailCount,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(`${WEBHOOK_SERVER_URL}/save-briefing`);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-briefing-pin': BRIEFING_PIN,
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── SEND NOTIFICATION EMAIL ──────────────────────────────────────────────────
async function sendNotificationEmail(auth, taskCounts, emailCount) {
  const gmail = google.gmail({ version: 'v1', auth });
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const briefingUrl = `${WEBHOOK_SERVER_URL}/briefing?pin=${BRIEFING_PIN}`;

  // Plain subject — no special characters to avoid encoding issues
  const subject = `Daily Briefing - ${today}`;

  const stats = [
    taskCounts.today > 0 ? `<strong style="color:#232323;">${taskCounts.today}</strong> due today` : null,
    taskCounts.overdue > 0 ? `<strong style="color:#ef4444;">${taskCounts.overdue}</strong> overdue` : null,
    taskCounts.upcoming > 0 ? `<strong style="color:#232323;">${taskCounts.upcoming}</strong> upcoming` : null,
    emailCount > 0 ? `<strong style="color:#232323;">${emailCount}</strong> emails` : null,
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F7F8FA;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F8FA;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

        <!-- Header -->
        <tr><td style="background:#232323;border-radius:12px 12px 0 0;padding:20px 28px;border-bottom:3px solid #FFD70A;">
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#aaa;">Movement Clinic</p>
          <p style="margin:6px 0 0;font-size:20px;font-weight:700;color:#F7F8FA;">Daily Briefing</p>
          <p style="margin:4px 0 0;font-size:13px;color:#888;">${today}</p>
        </td></tr>

        <!-- Stats row -->
        <tr><td style="background:#fff;padding:20px 28px;border-bottom:1px solid #e5e7eb;">
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.8;">${stats || 'Nothing urgent today.'}</p>
        </td></tr>

        <!-- CTA -->
        <tr><td style="background:#fff;padding:24px 28px;border-radius:0 0 12px 12px;">
          <a href="${briefingUrl}" style="display:inline-block;background:#232323;color:#F7F8FA;text-decoration:none;padding:13px 28px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:0.5px;">Open Briefing &rarr;</a>
          <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;">Tap to open your full briefing with tasks, emails, and calendar events.</p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 0 0;text-align:center;">
          <p style="margin:0;font-size:11px;color:#9ca3af;">Movement Clinic Daily Briefing &nbsp;·&nbsp; Auto-generated</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const boundary = 'briefing_boundary_' + Date.now();
  const messageParts = [
    `From: ${GMAIL_USER}`,
    `To: ${GMAIL_USER}`,
    `Subject: ${subject}`,
    `Content-Type: text/html; charset=utf-8`,
    'MIME-Version: 1.0',
    '',
    htmlBody,
  ];
  const raw = Buffer.from(messageParts.join('\n')).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  console.log(`✅ Notification email sent to ${GMAIL_USER}`);
}

// ─── MAIN RUN ─────────────────────────────────────────────────────────────────
async function runBriefing(silent = false) {
  console.log(`🚀 Running daily briefing — ${new Date().toISOString()}`);

  try {
    console.log('📋 Fetching Notion tasks...');
    const notionData = await getNotionTasks();
    console.log(`   Found ${notionData.allTasks.length} tasks (after 2025 filter)`);

    console.log('📅 Fetching calendar events...');
    const events = await getNotionEvents();
    console.log(`   Found ${events.length} upcoming events`);

    console.log('📧 Fetching Gmail inbox...');
    const emails = await getInboxEmails();
    console.log(`   Found ${emails.length} emails`);

    console.log('🤖 Analyzing with Claude...');
    const analysis = await analyzeWithClaude(notionData, emails, events);
    console.log(`   ${analysis.priority_actions_today?.length || 0} priority actions, ${analysis.emails_needing_response?.length || 0} emails need response`);

    console.log('✏️ Generating draft texts for mailto links...');
    const draftTexts = await generateDraftTexts(analysis.emails_needing_response, emails);

    console.log('💾 Posting briefing to server...');
    await postBriefingToServer(analysis, draftTexts, notionData, emails.length);

    if (!silent) {
      console.log('📨 Sending notification email...');
      const gmailAuth = await getGmailAuth();
      const taskCounts = {
        today: notionData.todayTasks.length,
        overdue: notionData.overdueTasks.length,
        upcoming: notionData.upcomingTasks.length,
        stale: notionData.staleTasks.length,
      };
      await sendNotificationEmail(gmailAuth, taskCounts, emails.length);
    } else {
      console.log('📨 Skipping notification email (silent refresh)');
    }

    console.log('✅ Done');
  } catch (err) {
    console.error('❌ Briefing failed:', err.message);
    console.error(err.stack);
  }
}

// ─── HTTP SERVER + TRIGGER ENDPOINT ──────────────────────────────────────────
// Lightweight Express server so Railway has a port to bind to and so Jordan
// can manually trigger the briefing from a browser without touching Railway UI.
const express = require('express');
const triggerApp = express();
triggerApp.use(express.json());

const TRIGGER_PORT = process.env.PORT || 3000;

// GET /trigger?pin=XXXX  — fires the briefing immediately
// Protected by BRIEFING_PIN so it's not publicly executable
triggerApp.get('/trigger', async (req, res) => {
  if (req.query.pin !== BRIEFING_PIN) {
    return res.status(403).send('Forbidden');
  }
  // Respond immediately — don't make the browser wait 60s for the full run
  res.send(`
    <html>
    <head>
      <meta charset="utf-8">
      <title>Briefing Triggered</title>
      <style>
        body { font-family: 'Montserrat', Arial, sans-serif; background: #F7F8FA; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: #232323; color: #F7F8FA; padding: 40px 48px; border-radius: 14px; border-bottom: 4px solid #FFD70A; text-align: center; max-width: 420px; }
        h1 { font-size: 20px; font-weight: 700; margin: 0 0 10px; }
        p { font-size: 13px; color: #aaa; margin: 0 0 24px; line-height: 1.6; }
        a { display: inline-block; background: #FFD70A; color: #232323; text-decoration: none; padding: 10px 24px; border-radius: 8px; font-size: 13px; font-weight: 700; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🚀 Briefing Running</h1>
        <p>The daily briefing has been triggered and is running in the background. It takes about 30–60 seconds to complete.</p>
        <a href="${WEBHOOK_SERVER_URL}/briefing?pin=${BRIEFING_PIN}" target="_blank">Open Briefing Page →</a>
      </div>
    </body>
    </html>
  `);
  // Fire briefing after response is sent
  const isSilent = req.query.silent === 'true';
  runBriefing(isSilent).catch(err => console.error('Manual trigger failed:', err.message));
});

// Health check
triggerApp.get('/health', (req, res) => {
  const heartbeatAgeMin = lastHeartbeatTime
    ? Math.floor((Date.now() - new Date(lastHeartbeatTime).getTime()) / 60000)
    : null;
  res.json({
    ok: true,
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
    heartbeat: {
      lastSent: lastHeartbeatTime,
      ageMinutes: heartbeatAgeMin,
      lastStatus: lastHeartbeatStatus,
      stale: heartbeatAgeMin !== null && heartbeatAgeMin > 30,
    },
  });
});

triggerApp.listen(TRIGGER_PORT, () => {
  console.log(`🌐 Daily briefing server listening on port ${TRIGGER_PORT}`);
});

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
if (process.env.RUN_NOW === 'true') {
  runBriefing();
} else {
  console.log(`⏰ Daily briefing scheduled: ${BRIEFING_SEND_TIME} (Railway server time)`);
  cron.schedule(BRIEFING_SEND_TIME, runBriefing);
}
