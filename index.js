const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GHL_API_KEY = process.env.GHL_API_KEY;
const QUO_API_KEY = process.env.QUO_API_KEY;
const GHL_LOCATION_ID = '6oqyEZ6nlqPw4cDsaKzi';
const GHL_SUMMARY_WEBHOOK = process.env.GHL_SUMMARY_WEBHOOK;
const TASK_ASSIGNEE_ID = '3EuCG6xznkq3A2CeDhDQ';
const TASK_TITLE = 'Claude Assistant: Follow up from previous conversation thread';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const PIPELINE_MANAGER_CHANNEL = 'C0ASJSMT76Y';

// File-backed dedup: prevents the same call ID from being processed more than once.
// Persisted to /data volume so it survives Railway restarts and redeploys.
const PROCESSED_CALLS_DIR = require('fs').existsSync('/data') ? '/data' : '/tmp';
const PROCESSED_CALLS_FILE = require('path').join(PROCESSED_CALLS_DIR, 'processed-calls.json');

function loadProcessedCalls() {
  try {
    if (require('fs').existsSync(PROCESSED_CALLS_FILE)) {
      const data = JSON.parse(require('fs').readFileSync(PROCESSED_CALLS_FILE, 'utf8'));
      // Prune entries older than 24 hours
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const pruned = {};
      for (const [id, ts] of Object.entries(data)) {
        if (ts > cutoff) pruned[id] = ts;
      }
      return pruned;
    }
  } catch (e) { /* fall through */ }
  return {};
}

function hasProcessedCall(callId) {
  const calls = loadProcessedCalls();
  return !!calls[callId];
}

function markCallProcessed(callId) {
  const calls = loadProcessedCalls();
  calls[callId] = Date.now();
  try {
    require('fs').writeFileSync(PROCESSED_CALLS_FILE, JSON.stringify(calls));
  } catch (e) {
    console.error('Failed to save processed calls:', e.message);
  }
}

// File-backed stage advancement guard — persists across Railway restarts/deploys.
// Uses the same /data volume as the briefing file.
const STAGE_GUARD_DIR = require('fs').existsSync('/data') ? '/data' : '/tmp';
const STAGE_GUARD_FILE = require('path').join(STAGE_GUARD_DIR, 'stage-advancement-guard.json');

function loadStageGuard() {
  try {
    if (require('fs').existsSync(STAGE_GUARD_FILE)) {
      return JSON.parse(require('fs').readFileSync(STAGE_GUARD_FILE, 'utf8'));
    }
  } catch (e) { /* fall through */ }
  return {};
}

function saveStageGuard(guard) {
  try {
    // Prune entries older than today to keep file small
    const today = new Date().toISOString().slice(0, 10);
    const pruned = {};
    for (const [id, date] of Object.entries(guard)) {
      if (date === today) pruned[id] = date;
    }
    require('fs').writeFileSync(STAGE_GUARD_FILE, JSON.stringify(pruned));
  } catch (e) {
    console.error('Failed to save stage guard:', e.message);
  }
}

function hasAdvancedTodayAlready(contactId) {
  const today = new Date().toISOString().slice(0, 10);
  const guard = loadStageGuard();
  return guard[contactId] === today;
}

function markAdvancedToday(contactId) {
  const today = new Date().toISOString().slice(0, 10);
  const guard = loadStageGuard();
  guard[contactId] = today;
  saveStageGuard(guard);
}

async function sendSlackPipelineUpdate(slackMessage, contactName, contactId) {
  if (!SLACK_BOT_TOKEN) {
    console.error('SLACK_BOT_TOKEN not set — skipping Slack notification');
    return;
  }
  try {
    const ghlUrl = `https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}`;
    await axios.post(
      'https://slack.com/api/chat.postMessage',
      {
        channel: PIPELINE_MANAGER_CHANNEL,
        text: slackMessage,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: slackMessage }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Open in GHL' },
                url: ghlUrl
              }
            ]
          }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Slack pipeline manager notification sent');
  } catch (err) {
    console.error('Failed to send Slack pipeline update:', err.response?.data || err.message);
  }
}

// Pipelines where only one opportunity is allowed across all of them
const LEAD_PIPELINE_IDS = [
  'TRrXnPy4hAeLDGwMNqrl', // FB Ad Eval
  '33yDa3WUaypShfeza92G', // Friends and Family Referral
  'kliYrSoSB5MF75T4R84B', // Google Ads Extension
  'KmePcT4T1I6DL9w5pyBm', // Google Ads Website
  'XGWrkugRXEFBP2DJsL9X', // Incoming Calls
  'F38gCGLVybaU0Sf72J68', // Website Leads
  'FyMN20G4jUAhNiDmhRXS'  // Past Patient Reactivation
];

// Ordered day/week progression for each pipeline - cap at Week 8
const PIPELINE_PROGRESSIONS = {
  'TRrXnPy4hAeLDGwMNqrl': [
    '8c20f0ea-c04f-4711-8772-fd2f3498e44e', // New Lead
    '2e4fe0dd-831a-4a06-a40f-42f1389ae52d', // Day 1
    '81c3b97e-2654-4a6d-b126-6dfca0cc20fc', // Day 2
    'cd0b48bb-6d28-4a94-9d56-356a9c440581', // Day 3
    '26cb842d-057f-4c66-8346-4caf013d9254', // Day 4
    'e7758452-6897-46cc-b5d7-18a747e1ebe7', // Day 5
    '299ab8d7-9131-4935-90b7-eefd09d94e7c', // Week 2
    '0506c939-6ecd-4a22-8ba3-15e0f192f2f3', // Week 3
    'e311b502-3301-4be0-8b0d-0b84c578603d', // Week 4
    '804a7e8b-2d32-4796-9951-71f9380b7363', // Week 6
    '8b60c0b1-6f5d-450f-bcff-30334583891b'  // Week 8 (cap)
  ],
  '33yDa3WUaypShfeza92G': [
    'a8d2d0d5-8fea-4e1a-b11e-25c84c20ab2a', // New Referral
    'a6c8bc1b-89ff-4866-84fb-b3fc387165e9', // Day 1
    '184a5656-868a-47fa-962e-98381e532f97', // Day 2
    'a9e89b32-7959-4a21-b0ec-ecf21c3f6bd9', // Day 3
    'fde509bd-6ec1-4f23-a218-6b1abf7c9114', // Day 4
    'ed2890df-8bd1-4736-8a8b-369c4348e840', // Day 5
    '682effa5-0fd4-4fe2-a6ea-bf96225c1b80', // Week 2
    '50c5efb0-a5b7-4dda-9bb4-45cb15d17416', // Week 3
    'a003f989-6f14-4012-ba05-7d7a5baeb675', // Week 4
    'e4ee0cf2-4a4e-4431-a16b-28dfda2c8da0', // Week 6
    'f21618e4-4642-4627-935b-62a05adc325d'  // Week 8 (cap)
  ],
  'kliYrSoSB5MF75T4R84B': [
    'be01863f-f7b9-41b1-9700-a29b03ffac59', // New Lead
    '05b51566-85a1-477e-9026-848a36a1181d', // Day 1
    '8b664cc5-afe6-4576-8049-dce8b8ff238f', // Day 2
    '6855b2e5-0623-4bc0-b8d5-f47be8c19b21', // Day 3
    '59efd4d4-e718-4335-89df-ef34c11bfd1b', // Day 4
    'd5ba2bc2-65ac-4555-b02e-e035539cc3b9', // Day 5
    '0329f6d9-4990-434b-b474-bf510faf28b4', // Week 2
    '1abed4ac-c488-454a-88b1-56e3041ebddf', // Week 3
    '2acaa3fc-2acc-40d5-ac68-4ce6a056f979', // Week 4
    '182ac7da-303e-4d8f-950d-b5402de7cf76', // Week 6
    '8a123830-68e0-457f-9c37-1308d93b6ddf'  // Week 8 (cap)
  ],
  'KmePcT4T1I6DL9w5pyBm': [
    '1e9441c2-b2b0-4b09-9ecf-04f2d0b6fdea', // New Lead
    '8d29d7de-5acd-46fa-8204-0850fcfa3970', // Day 1
    '08f3aa7d-bd9d-473d-b2c3-33aaddbcaa07', // Day 2
    '5833d071-6c1e-4525-9a51-30fa42453f82', // Day 3
    '8d6eb390-86e4-429f-9fdf-6e2bf71ad5da', // Day 4
    '8f15f16c-d806-47d9-87a8-4012e9fe3dd8', // Day 5
    '2897bdf7-e765-4b18-a6f2-43b75e096e11', // Week 2
    '19f29d13-421b-4193-baf3-3dd294691ba1', // Week 3
    '616a1aad-8bb8-4b0c-9d65-7ec61dec4188', // Week 4
    '47a06d94-6f3a-42d8-b52c-9a039ae0d575', // Week 6
    '866ecc5a-f75b-41fb-9ecf-8cbd6a9c279b'  // Week 8 (cap)
  ],
  'XGWrkugRXEFBP2DJsL9X': [
    'a43858b6-f06d-4939-8e31-a09739605200', // New Call
    '66e18cde-0c8b-421e-a81f-47d35981d4a3', // Day 1
    'fc993a46-15dc-4413-8b9a-9fd6dff7df02', // Day 2
    '2e9c4839-1e9f-489e-95e2-6f52f20f4230', // Day 3
    'ae3b89af-1018-44b0-b35e-e97b7e4db055', // Day 4
    'f9cb35b7-5784-4767-b346-d1d777b48f3c', // Day 5
    '7656c972-d4c4-4812-b980-69f0f9fe37fc', // Week 2
    '990ef284-0485-47e9-b1a4-1fa172045925', // Week 3
    '6ad34c98-92c2-4b77-8523-78e38c611501', // Week 4
    'a792b491-d9d3-4696-9caa-98ba76c4c1f3', // Week 6
    'b5c9a81d-6d70-41b7-8dfe-5c4800a56683'  // Week 8 (cap)
  ],
  'F38gCGLVybaU0Sf72J68': [
    '29aa3247-ca97-4790-9246-7ad903180337', // New Lead
    'e634293b-4ea8-4b9a-9c87-da7b1db97ec9', // Day 1
    '258cae81-bbc2-4e05-82c0-4ae0ec9c3567', // Day 2
    '3a56f6a6-1a97-4ad6-8fb9-e65fb7d2fe49', // Day 3
    'e8957ecf-de26-418c-99a7-288c06c47100', // Day 4
    'e7f2038c-6d6e-442e-824b-e46688c630e0', // Day 5
    'b65809a0-dbf5-43ff-b414-4a5859747d62', // Week 2
    '5a838d0c-521c-48fb-a177-ec7a499c298e', // Week 3
    '10b59891-d4c5-4b67-9731-8b81704610ee', // Week 4
    '3ac659e7-ac3a-44f6-8f53-46a9f93d48b7', // Week 6
    '966e9941-898d-47e2-881e-8f675440b463'  // Week 8 (cap)
  ],
  'FyMN20G4jUAhNiDmhRXS': [
    '59dba40e-4e9a-4946-babe-767a3ae0e712', // New Lead
    '5f098e07-7076-409c-be40-50f4549f5077', // Day 1
    '4c1031a5-74fb-4d29-8a08-57daf33f8a37', // Day 2
    'cc4cce25-7cd5-4746-a8ae-6deab243fcad', // Day 3
    '31bb40aa-a9e4-49c2-babd-5d374e4afd0c', // Day 4
    '180e7c32-4e68-4e60-baf6-49447bf9c354', // Day 5
    '0ad13649-059c-4627-b776-0ceccf8ea95c', // Week 2
    'e63e5525-8f4e-407e-9b9c-38ea3f52d29c', // Week 3
    '0cceb2b9-88c0-4b0b-9cef-8410bc14fc27', // Week 4
    'f2e04f8c-b6f3-4b19-83ad-60b90b7ff644', // Week 6
    'a80e08aa-c2da-41d4-8656-7a0ba6c37b7f'  // Week 8 (cap)
  ]
};

function getNextStageInProgression(pipelineId, currentStageId) {
  const progression = PIPELINE_PROGRESSIONS[pipelineId];
  if (!progression) return null;
  const currentIndex = progression.indexOf(currentStageId);
  if (currentIndex === -1) return progression[1] || null; // not in progression, start at Day 1
  if (currentIndex >= progression.length - 1) return progression[progression.length - 1]; // already at cap
  return progression[currentIndex + 1];
}

const PIPELINE_NAMES = {
  'TRrXnPy4hAeLDGwMNqrl': 'FB Ad Eval Pipeline',
  '33yDa3WUaypShfeza92G': 'Friends and Family Referral 2.0',
  'kliYrSoSB5MF75T4R84B': 'Google Ads - Extension',
  'KmePcT4T1I6DL9w5pyBm': 'Google Ads - Website',
  'XGWrkugRXEFBP2DJsL9X': 'Incoming Calls',
  'F38gCGLVybaU0Sf72J68': 'Website Leads',
  'FyMN20G4jUAhNiDmhRXS': 'Past Patient Reactivation - Manual',
  '0UnRjFIzcaUf35zXVXmT': 'Customer Pipeline',
  'UwFUs0w3nmj6k0f1EEXm': 'Continuity Pipeline'
};

const STAGE_NAMES = {
  // FB Ad Eval
  '8c20f0ea-c04f-4711-8772-fd2f3498e44e': 'New Lead',
  '2e4fe0dd-831a-4a06-a40f-42f1389ae52d': 'Day 1',
  '81c3b97e-2654-4a6d-b126-6dfca0cc20fc': 'Day 2',
  'cd0b48bb-6d28-4a94-9d56-356a9c440581': 'Day 3',
  '26cb842d-057f-4c66-8346-4caf013d9254': 'Day 4',
  'e7758452-6897-46cc-b5d7-18a747e1ebe7': 'Day 5',
  '299ab8d7-9131-4935-90b7-eefd09d94e7c': 'Week 2 (2x/wk)',
  '0506c939-6ecd-4a22-8ba3-15e0f192f2f3': 'Week 3 (1x/wk)',
  'e311b502-3301-4be0-8b0d-0b84c578603d': 'Week 4 (1x/wk)',
  '804a7e8b-2d32-4796-9951-71f9380b7363': 'Week 6 (1x/wk)',
  '8b60c0b1-6f5d-450f-bcff-30334583891b': 'Week 8 (1x/wk)',
  '5a2bcdd2-efc6-4787-8b8d-5def8a889212': 'Eval Scheduled',
  '5cd82fda-e4a2-4017-8fa5-7e057f050f8f': 'On Hold',
  'd24c4257-1cec-4423-9e8a-0fdd6b0b6e70': 'Possible Disqualifier - Needs Review',
  '0dbeef43-65d6-49c6-a10b-8032ce9d2bf3': 'Phone Call Completed - Didnt Schedule',
  // Friends and Family
  'a8d2d0d5-8fea-4e1a-b11e-25c84c20ab2a': 'New Referral',
  'a6c8bc1b-89ff-4866-84fb-b3fc387165e9': 'Day 1',
  '184a5656-868a-47fa-962e-98381e532f97': 'Day 2',
  'a9e89b32-7959-4a21-b0ec-ecf21c3f6bd9': 'Day 3',
  'fde509bd-6ec1-4f23-a218-6b1abf7c9114': 'Day 4',
  'ed2890df-8bd1-4736-8a8b-369c4348e840': 'Day 5',
  '682effa5-0fd4-4fe2-a6ea-bf96225c1b80': 'Week 2 (2x/wk)',
  '50c5efb0-a5b7-4dda-9bb4-45cb15d17416': 'Week 3 (1x/wk)',
  'a003f989-6f14-4012-ba05-7d7a5baeb675': 'Week 4 (1x/wk)',
  'e4ee0cf2-4a4e-4431-a16b-28dfda2c8da0': 'Week 6 (1x/wk)',
  'f21618e4-4642-4627-935b-62a05adc325d': 'Week 8 (1x/wk)',
  '375867bd-6e2f-437e-9a68-01ef80a7568b': 'Eval Scheduled',
  '7e7b8c45-1b4f-455d-bba3-bb4720c5eaa7': 'Possible Disqualifier - Needs Review',
  // Google Ads Extension
  'be01863f-f7b9-41b1-9700-a29b03ffac59': 'New Lead',
  '05b51566-85a1-477e-9026-848a36a1181d': 'Day 1',
  '8b664cc5-afe6-4576-8049-dce8b8ff238f': 'Day 2',
  '6855b2e5-0623-4bc0-b8d5-f47be8c19b21': 'Day 3',
  '59efd4d4-e718-4335-89df-ef34c11bfd1b': 'Day 4',
  'd5ba2bc2-65ac-4555-b02e-e035539cc3b9': 'Day 5',
  '0329f6d9-4990-434b-b474-bf510faf28b4': 'Week 2 (2x/wk)',
  '1abed4ac-c488-454a-88b1-56e3041ebddf': 'Week 3 (1x/wk)',
  '2acaa3fc-2acc-40d5-ac68-4ce6a056f979': 'Week 4 (1x/wk)',
  '182ac7da-303e-4d8f-950d-b5402de7cf76': 'Week 6 (1x/wk)',
  '8a123830-68e0-457f-9c37-1308d93b6ddf': 'Week 8 (1x/wk)',
  'c1c10a66-c896-409a-95bd-1661d1f72812': 'Eval Scheduled',
  '76f72c48-7fa8-437a-a1d6-8f3904ab66da': 'Possible Disqualifier - Needs Review',
  '3ad3d42c-d368-4980-828d-f1fb2f127456': 'Talked To But Didnt Schedule',
  '01421111-996d-4a05-864a-20a67d79b2e1': 'Call Later / In a Few Months',
  // Google Ads Website
  '1e9441c2-b2b0-4b09-9ecf-04f2d0b6fdea': 'New Lead',
  '8d29d7de-5acd-46fa-8204-0850fcfa3970': 'Day 1',
  '08f3aa7d-bd9d-473d-b2c3-33aaddbcaa07': 'Day 2',
  '5833d071-6c1e-4525-9a51-30fa42453f82': 'Day 3',
  '8d6eb390-86e4-429f-9fdf-6e2bf71ad5da': 'Day 4',
  '8f15f16c-d806-47d9-87a8-4012e9fe3dd8': 'Day 5',
  '2897bdf7-e765-4b18-a6f2-43b75e096e11': 'Week 2 (2x/wk)',
  '19f29d13-421b-4193-baf3-3dd294691ba1': 'Week 3 (1x/wk)',
  '616a1aad-8bb8-4b0c-9d65-7ec61dec4188': 'Week 4 (1x/wk)',
  '47a06d94-6f3a-42d8-b52c-9a039ae0d575': 'Week 6 (1x/wk)',
  '866ecc5a-f75b-41fb-9ecf-8cbd6a9c279b': 'Week 8 (1x/wk)',
  '4eedf687-3c25-47b8-a40d-92b9c6e8606f': 'Eval Scheduled',
  '2a88c0e2-7cc3-4552-ad35-81c5679289bb': 'Possible Disqualifier - Needs Review',
  'db1aa389-4a09-4242-8c09-cd7893212ef9': 'Talked To But Didnt Schedule',
  '379a6e20-a2a3-4087-99a6-42bb2bb7c2a2': 'Call Later / In a Few Months',
  // Incoming Calls
  'a43858b6-f06d-4939-8e31-a09739605200': 'New Call',
  '66e18cde-0c8b-421e-a81f-47d35981d4a3': 'Day 1',
  'fc993a46-15dc-4413-8b9a-9fd6dff7df02': 'Day 2',
  '2e9c4839-1e9f-489e-95e2-6f52f20f4230': 'Day 3',
  'ae3b89af-1018-44b0-b35e-e97b7e4db055': 'Day 4',
  'f9cb35b7-5784-4767-b346-d1d777b48f3c': 'Day 5',
  '7656c972-d4c4-4812-b980-69f0f9fe37fc': 'Week 2 (2x/wk)',
  '990ef284-0485-47e9-b1a4-1fa172045925': 'Week 3 (1x/wk)',
  '6ad34c98-92c2-4b77-8523-78e38c611501': 'Week 4 (1x/wk)',
  'a792b491-d9d3-4696-9caa-98ba76c4c1f3': 'Week 6 (1x/wk)',
  'b5c9a81d-6d70-41b7-8dfe-5c4800a56683': 'Week 8 (1x/wk)',
  'd04df06e-817f-4ea9-8bee-61038fada054': 'Eval Scheduled',
  '0fc9e4ee-4d34-46e6-ae1a-23f6380e8ade': 'Needs Follow Up - FU Date NOT Booked',
  '1136b553-9e22-4cf5-9f58-ee8299bb7768': 'Needs Follow Up - FU Date Booked',
  'b182d41d-eba4-4a1a-ae7b-23ed1c838b66': 'Possible Disqualifier - Needs Review',
  '804852b0-e633-4154-aa72-00afdce3c857': 'Talked to - No Follow Up Needed',
  'bee31474-bfdd-4366-93e7-d7190af8208a': 'On Hold',
  'f0689224-5471-4cb5-a9b2-ccbcbc8f6ca0': 'Wrong Number',
  // Website Leads
  '29aa3247-ca97-4790-9246-7ad903180337': 'New Lead',
  'e634293b-4ea8-4b9a-9c87-da7b1db97ec9': 'Day 1',
  '258cae81-bbc2-4e05-82c0-4ae0ec9c3567': 'Day 2',
  '3a56f6a6-1a97-4ad6-8fb9-e65fb7d2fe49': 'Day 3',
  'e8957ecf-de26-418c-99a7-288c06c47100': 'Day 4',
  'e7f2038c-6d6e-442e-824b-e46688c630e0': 'Day 5',
  'b65809a0-dbf5-43ff-b414-4a5859747d62': 'Week 2 (2x/wk)',
  '5a838d0c-521c-48fb-a177-ec7a499c298e': 'Week 3 (1x/wk)',
  '10b59891-d4c5-4b67-9731-8b81704610ee': 'Week 4 (1x/wk)',
  '3ac659e7-ac3a-44f6-8f53-46a9f93d48b7': 'Week 6 (1x/wk)',
  '966e9941-898d-47e2-881e-8f675440b463': 'Week 8 (1x/wk)',
  'd19066ec-e4e2-43fe-bcc8-815e36a0cc9b': 'Eval Scheduled',
  'ec452b63-80f5-4122-8081-99158ffcb6be': 'Possible Disqualifier - Needs Review',
  'd2429fa0-2c21-44f3-9b53-8acc9664fe49': 'On Hold',
  '44e723b8-c221-4832-8d62-f996f7d2d50c': 'Talked To But Didnt Schedule',
  // Past Patient Reactivation
  '59dba40e-4e9a-4946-babe-767a3ae0e712': 'New Lead',
  '5f098e07-7076-409c-be40-50f4549f5077': 'Day 1',
  '4c1031a5-74fb-4d29-8a08-57daf33f8a37': 'Day 2',
  'cc4cce25-7cd5-4746-a8ae-6deab243fcad': 'Day 3',
  '31bb40aa-a9e4-49c2-babd-5d374e4afd0c': 'Day 4',
  '180e7c32-4e68-4e60-baf6-49447bf9c354': 'Day 5',
  '0ad13649-059c-4627-b776-0ceccf8ea95c': 'Week 2 (2x/wk)',
  'e63e5525-8f4e-407e-9b9c-38ea3f52d29c': 'Week 3 (1x/wk)',
  '0cceb2b9-88c0-4b0b-9cef-8410bc14fc27': 'Week 4 (1x/wk)',
  'f2e04f8c-b6f3-4b19-83ad-60b90b7ff644': 'Week 6 (1x/wk)',
  'a80e08aa-c2da-41d4-8656-7a0ba6c37b7f': 'Week 8 (1x/wk)',
  '42e1a1bd-2d4e-4b00-9106-223d0660d49f': 'Eval Scheduled',
  '84a40b37-ee72-475e-942b-37f328c85d95': 'Possible Disqualifier - Needs Review',
  'b36ad65f-ef7d-45c5-b323-8234de779e7d': 'On Hold',
  'fe442c2a-9c6b-452a-aefd-af66b5c29cc4': 'Talked To But Didnt Schedule',
  'd37b7a91-220d-4a45-8d99-2f09de2ab009': 'Free Screen Scheduled'
};

const CLINIC_PHONE_NUMBERS = ['+16266693778'];

const CLAUDE_PROMPT = `You are a CRM assistant for Movement Clinic Physical Therapy, a cash-based physical therapy clinic in Pasadena, CA. You analyze completed phone call transcripts and determine what CRM updates to make.

PIPELINE AND STAGE REFERENCE:

FB Ad Eval Pipeline (TRrXnPy4hAeLDGwMNqrl):
- Eval Scheduled: 5a2bcdd2-efc6-4787-8b8d-5def8a889212
- On Hold: 5cd82fda-e4a2-4017-8fa5-7e057f050f8f
- Possible Disqualifier: d24c4257-1cec-4423-9e8a-0fdd6b0b6e70
- Phone Call Completed Didnt Schedule: 0dbeef43-65d6-49c6-a10b-8032ce9d2bf3

Friends and Family Referral (33yDa3WUaypShfeza92G):
- Eval Scheduled: 375867bd-6e2f-437e-9a68-01ef80a7568b
- Possible Disqualifier: 7e7b8c45-1b4f-455d-bba3-bb4720c5eaa7

Google Ads Extension (kliYrSoSB5MF75T4R84B):
- Eval Scheduled: c1c10a66-c896-409a-95bd-1661d1f72812
- Talked To But Didnt Schedule: 3ad3d42c-d368-4980-828d-f1fb2f127456
- Call Later: 01421111-996d-4a05-864a-20a67d79b2e1
- Possible Disqualifier: 76f72c48-7fa8-437a-a1d6-8f3904ab66da

Google Ads Website (KmePcT4T1I6DL9w5pyBm):
- Eval Scheduled: 4eedf687-3c25-47b8-a40d-92b9c6e8606f
- Talked To But Didnt Schedule: db1aa389-4a09-4242-8c09-cd7893212ef9
- Call Later: 379a6e20-a2a3-4087-99a6-42bb2bb7c2a2
- Possible Disqualifier: 2a88c0e2-7cc3-4552-ad35-81c5679289bb

Incoming Calls (XGWrkugRXEFBP2DJsL9X):
- Eval Scheduled: d04df06e-817f-4ea9-8bee-61038fada054
- Needs Follow Up FU Date NOT Booked: 0fc9e4ee-4d34-46e6-ae1a-23f6380e8ade
- Needs Follow Up FU Date Booked: 1136b553-9e22-4cf5-9f58-ee8299bb7768
- Possible Disqualifier: b182d41d-eba4-4a1a-ae7b-23ed1c838b66
- Talked to No Follow Up Needed: 804852b0-e633-4154-aa72-00afdce3c857
- On Hold: bee31474-bfdd-4366-93e7-d7190af8208a
- Wrong Number: f0689224-5471-4cb5-a9b2-ccbcbc8f6ca0

Website Leads (F38gCGLVybaU0Sf72J68):
- Eval Scheduled: d19066ec-e4e2-43fe-bcc8-815e36a0cc9b
- Talked To But Didnt Schedule: 44e723b8-c221-4832-8d62-f996f7d2d50c
- On Hold: d2429fa0-2c21-44f3-9b53-8acc9664fe49
- Possible Disqualifier: ec452b63-80f5-4122-8081-99158ffcb6be

Past Patient Reactivation (FyMN20G4jUAhNiDmhRXS):
- Eval Scheduled: 42e1a1bd-2d4e-4b00-9106-223d0660d49f
- Free Screen Scheduled: d37b7a91-220d-4a45-8d99-2f09de2ab009
- Talked To But Didnt Schedule: fe442c2a-9c6b-452a-aefd-af66b5c29cc4
- On Hold: b36ad65f-ef7d-45c5-b323-8234de779e7d
- Possible Disqualifier: 84a40b37-ee72-475e-942b-37f328c85d95

IMPORTANT: Do NOT assign Day/Week stages. The system handles day and week progression automatically for voicemail and no-contact outcomes. Only assign the named outcome stages listed above.

DECISION RULES:

1. CONVERSATION TYPE CHECK: Determine what type of call this was. Pay special attention to whether the contact is currently in an Eval Scheduled stage — this changes the decision logic significantly (see EVAL SCHEDULED CONTACT rules below).

2. NAME EXTRACTION: If the contact name is unknown or a placeholder, attempt to extract the caller name from the transcript. Look for introductions. If found set extracted_name to that name, otherwise null.

3. ATTRIBUTION: If this is a new contact with no existing pipeline, look for attribution signals in the transcript (Facebook ad mention, Google search, referral, website). Use this to select the most appropriate pipeline. Default to Incoming Calls if unclear.

4. FOLLOW UP TIMEFRAME: If the person requests follow up at a specific future time, extract that timeframe as a number of days from today. For example "call me in 2 months" = 60, "reach out next January" = calculate from today, "in a few weeks" = 21. Set follow_up_days to this number if applicable, otherwise null.

5. EVAL SCHEDULED CONTACT RULES: If the current stage is Eval Scheduled, apply these rules FIRST before the general outcomes below:

EVAL SCHEDULED — CONFIRMATORY CALL: Call is about confirming the appointment, asking prep questions, logistics, or general check-in with no indication of cancellation. Set action to NO_ACTION. Add a note only. Do not move the stage.

EVAL SCHEDULED — HARD CANCEL: Contact explicitly cancels and states they are going to an in-network facility, competitor, or otherwise will not be moving forward with the evaluation and gives no indication of returning. Move to Possible Disqualifier stage. Log the reason.

EVAL SCHEDULED — SOFT CANCEL: Contact cancels or postpones due to softer reasons — timing, life circumstances, wants to think more, price concerns, needs to discuss with spouse — but has not ruled out returning. Move to Needs Follow Up or Talked To But Didnt Schedule stage. Log the reason. Set follow_up_days if a timeframe was mentioned.

6. Based on the transcript, determine the outcome:

OUTCOME A - EVAL SCHEDULED: Person agreed to come in for an evaluation or free screen. Move to Eval Scheduled stage. Log appointment details if mentioned.

OUTCOME B - NEEDS FOLLOW UP: Person gave an objection but did not disengage. Common objections: wants insurance/in-network care, needs to speak with spouse, needs to think about it, price concerns, not ready yet, requested follow-up by email or phone in a specific timeframe. Move to the most appropriate Needs Follow Up or Talked To But Didnt Schedule stage. Log the specific objection. If a timeframe was mentioned, extract follow_up_days.

OUTCOME C - ON HOLD: Person explicitly said they want to be contacted again at a specific future time. Move to On Hold or Call Later stage. Log the timeframe.

OUTCOME D - POSSIBLE DISQUALIFIER: Transcript contains explicit mention of: Medicare or Medicaid, diagnosis outside outpatient orthopedic or sports PT scope, exclusively seeking insurance-based care with zero openness to cash pay, geographic location too far, or explicitly choosing a competitor/in-network facility with no intent to return. Move to Possible Disqualifier stage. Log the specific reason.

OUTCOME E - WRONG NUMBER: Call was a wrong number or spam. Move to Wrong Number stage if Incoming Calls, otherwise NO_ACTION on stage.

OUTCOME F - VOICEMAIL: A voicemail was left. The system will automatically advance the day/week stage. Just set action to UPDATE and return the current pipeline ID and null for new_stage_id. Log what was said in the voicemail.

OUTCOME G - NO CONTACT: No answer, no voicemail, call under 5 seconds. The system will automatically advance the day/week stage. Set action to UPDATE and return current pipeline ID and null for new_stage_id. Log the attempt.

OPPORTUNITY VALUE RULE: Only suggest a value if person explicitly agreed to a specific service with a discussed price. Do not guess. If uncertain return null.

RETURN ONLY valid JSON with no other text, no preamble, no markdown:
{"action":"UPDATE or NO_ACTION","outcome":"EVAL_SCHEDULED or NEEDS_FOLLOW_UP or ON_HOLD or POSSIBLE_DISQUALIFIER or WRONG_NUMBER or VOICEMAIL or NO_CONTACT","new_stage_id":"exact stage ID from reference above or null","new_pipeline_id":"pipeline ID or null","opportunity_value":null,"note":"2-4 sentence summary with timestamp context. Be factual and specific.","disqualifier_reason":"only if POSSIBLE_DISQUALIFIER otherwise null","extracted_name":"name from transcript or null","follow_up_days":null,"confidence_score":85,"confidence_reason":"1 sentence explanation of confidence level — e.g. clear conversation with explicit booking confirmed, or short call with ambiguous intent"}`;

async function getCallDetails(callId) {
  const response = await axios.get(`https://api.openphone.com/v1/calls/${callId}`, {
    headers: { 'Authorization': QUO_API_KEY, 'Content-Type': 'application/json' }
  });
  return response.data;
}

function extractContactPhone(callData) {
  const participants = callData.data?.participants || callData.participants || [];
  for (const p of participants) {
    if (!CLINIC_PHONE_NUMBERS.includes(p)) return p;
  }
  return null;
}

async function findGHLContact(phone) {
  const cleanPhone = phone.replace(/\D/g, '');
  const response = await axios.get(
    `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${cleanPhone}`,
    { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
  );
  const contacts = response.data.contacts;
  return contacts && contacts.length > 0 ? contacts[0] : null;
}

async function findGHLContactById(contactId) {
  const response = await axios.get(
    `https://services.leadconnectorhq.com/contacts/${contactId}`,
    { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
  );
  return response.data.contact;
}

async function updateGHLContactName(contactId, firstName, lastName) {
  await axios.put(
    `https://services.leadconnectorhq.com/contacts/${contactId}`,
    { firstName, lastName },
    { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' } }
  );
}

async function getAllContactOpportunities(contactId) {
  const response = await axios.get(
    `https://services.leadconnectorhq.com/opportunities/search?contact_id=${contactId}&location_id=${GHL_LOCATION_ID}`,
    { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
  );
  return response.data.opportunities || [];
}

function findLeadOpportunity(opportunities) {
  // Find the most recently updated open opportunity in any lead pipeline
  const leadOpps = opportunities.filter(o =>
    o.status === 'open' && LEAD_PIPELINE_IDS.includes(o.pipelineId)
  );
  if (leadOpps.length === 0) return null;
  return leadOpps.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
}

async function createOrFindGHLContact(phone, name) {
  const nameParts = name ? name.trim().split(' ') : [];
  const firstName = nameParts[0] || 'Incoming Call';
  const lastName = nameParts.slice(1).join(' ') || 'No Name Provided';
  try {
    const response = await axios.post(
      'https://services.leadconnectorhq.com/contacts/',
      { locationId: GHL_LOCATION_ID, firstName, lastName, phone, source: 'Quo Call' },
      { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' } }
    );
    return { contact: response.data.contact, isNew: true };
  } catch (err) {
    if (err.response?.data?.meta?.contactId) {
      const existing = await findGHLContactById(err.response.data.meta.contactId);
      return { contact: existing, isNew: false };
    }
    throw err;
  }
}

async function createGHLOpportunity(contactId, pipelineId, stageId, name) {
  const response = await axios.post(
    'https://services.leadconnectorhq.com/opportunities/',
    { pipelineId, locationId: GHL_LOCATION_ID, name, pipelineStageId: stageId, status: 'open', contactId },
    { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' } }
  );
  return response.data.opportunity;
}

async function updateGHLOpportunity(opportunityId, pipelineId, stageId, value) {
  const body = { pipelineId, pipelineStageId: stageId };
  if (value !== null && value !== undefined) body.monetaryValue = value;
  await axios.put(
    `https://services.leadconnectorhq.com/opportunities/${opportunityId}`,
    body,
    { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' } }
  );
}

async function addNoteToContact(contactId, noteText) {
  await axios.post(
    `https://services.leadconnectorhq.com/contacts/${contactId}/notes`,
    { body: noteText, userId: '' },
    { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' } }
  );
}

async function createGHLTask(contactId, title, dueDate) {
  await axios.post(
    `https://services.leadconnectorhq.com/contacts/${contactId}/tasks`,
    {
      title,
      body: 'Generated by Claude post-call automation based on contact request.',
      dueDate: dueDate.toISOString(),
      completed: false,
      assignedTo: TASK_ASSIGNEE_ID
    },
    { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' } }
  );
}

// Quo user ID → PT name mapping
// These IDs come from the Quo API (answeredBy / userId field on call objects)
const QUO_USER_MAP = {
  'USA0DVhDhZ': 'John Gan',
  'USD3Kno24F': 'Shane Abbott',
  'USHRRvAybv': 'Katy Vieira',
  'USLnAV6kpl': 'Jordan McCormack',
  'USnPowYhI2': 'TJ Aquino',
  'USYIrAQecv': 'Chris Bostwick'
};

function capitalizeFullName(name) {
  if (!name) return 'Unknown';
  return name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function extractTeamMember(callData) {
  const data = callData.data || callData;
  const userId = data.answeredBy || data.userId || data.initiatedBy || null;
  if (userId && QUO_USER_MAP[userId]) return QUO_USER_MAP[userId];
  // Log the userId so we can map it if not yet in QUO_USER_MAP
  if (userId) console.log(`Unknown Quo userId — add to QUO_USER_MAP: ${userId}`);
  return null;
}

function buildCallSlackBlocks(params) {
  const {
    contactName, contactPhone, callTime, teamMember, outcome,
    pipeline, stageDisplay, redFlags, note, isNewOpportunity,
    confidenceScore, confidenceReason, contactId
  } = params;

  const hasFlag = redFlags && redFlags !== 'None' && redFlags !== 'null' && redFlags !== 'None identified.';
  const score = parseInt(confidenceScore) || 0;
  const confidenceEmoji = score >= 90 ? ':large_green_circle:' : score >= 80 ? ':large_yellow_circle:' : ':red_circle:';
  const confidenceText = `${confidenceEmoji} *${score}% Confident in Transcript Interpretation*`;
  const pipelineDisplay = isNewOpportunity
    ? 'New opportunity — added to ' + pipeline + ' pipeline'
    : 'Pre-existed in ' + pipeline + ' pipeline';
  const ghlUrl = `https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}`;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Claude AI Assistant — Call Summary', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: confidenceText + (confidenceReason ? '\n_' + confidenceReason + '_' : '') } },
    { type: 'divider' },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: '*Name*\n' + capitalizeFullName(contactName) },
      { type: 'mrkdwn', text: '*Phone*\n' + (contactPhone || 'Unknown') },
      { type: 'mrkdwn', text: '*Call Time*\n' + (callTime || 'Unknown') },
      { type: 'mrkdwn', text: '*Team Member on Phone Call*\n' + (teamMember || 'Not identified') }
    ]},
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: '*Outcome*\n' + (note || outcome || 'See GHL for details') } },
    { type: 'divider' },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: '*Pipeline*\n' + pipelineDisplay },
      { type: 'mrkdwn', text: '*Stage*\n' + (stageDisplay || 'Unknown') }
    ]},
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: (hasFlag ? ':warning: ' : ':white_check_mark: ') + '*Red Flags to Be Aware Of*\n' + (redFlags || 'None') } },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in GHL' }, url: ghlUrl }] }
  ];

  return {
    fallback: 'Claude AI Assistant — Call Summary for ' + capitalizeFullName(contactName),
    blocks
  };
}

async function sendSlackMessage(channel, blocksPayload) {
  if (!SLACK_BOT_TOKEN) {
    console.error('SLACK_BOT_TOKEN not set — skipping Slack notification');
    return;
  }
  try {
    await axios.post(
      'https://slack.com/api/chat.postMessage',
      { channel, text: blocksPayload.fallback, blocks: blocksPayload.blocks },
      { headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`Slack message sent to ${channel}`);
  } catch (err) {
    console.error('Failed to send Slack message:', err.response?.data || err.message);
  }
}

async function fireGHLSummaryWebhook(summaryData) {
  if (!GHL_SUMMARY_WEBHOOK) return;
  try {
    const sanitized = {};
    for (const [key, val] of Object.entries(summaryData)) {
      if (val === null || val === undefined) sanitized[key] = '';
      else if (typeof val === 'object') sanitized[key] = JSON.stringify(val);
      else sanitized[key] = String(val).replace(/\n/g, ' ').replace(/\r/g, '');
    }
    await axios.post(GHL_SUMMARY_WEBHOOK, sanitized, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('Summary webhook fired to GHL successfully');
  } catch (err) {
    console.error('Failed to fire GHL summary webhook:', err.message);
  }
}

async function analyzeWithClaude(transcript, pipelineId, stageId, contactName) {
  const userMessage = `${CLAUDE_PROMPT}\n\nCurrent Pipeline ID: ${pipelineId || 'None - new contact'}\nCurrent Stage ID: ${stageId || 'None - new contact'}\nContact Name on File: ${contactName || 'Unknown'}\n\nCALL TRANSCRIPT:\n${transcript}`;
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: userMessage }] },
    { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
  );
  const text = response.data.content[0].text;
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function generateCallEmailContent(params) {
  const { contactName, contactPhone, outcome, note, pipelineName, previousStage, newStage, stageChanged, opportunityValue, disqualifierReason, isNewContact, isNewOpportunity, taskCreated, followUpDays, nameExtracted } = params;

  const prompt = `You are writing a post-call summary email for Movement Clinic Physical Therapy's internal team. Based on the information below, write a clean HTML email body and a plain text Slack message. Be concise and direct.

CALL DATA:
- Contact: ${contactName} | ${contactPhone}
- Outcome: ${outcome}
- Call Summary: ${note}
- Pipeline: ${pipelineName}
- Stage Changed: ${stageChanged ? previousStage + ' to ' + newStage : 'No change — ' + newStage}
- New Contact Created: ${isNewContact ? 'Yes' : 'No'}
- New Opportunity Created: ${isNewOpportunity ? 'Yes' : 'No'}
- Name Extracted from Transcript: ${nameExtracted || 'No'}
- Opportunity Value Update: ${opportunityValue || 'No change'}
- Follow-Up Task Created: ${taskCreated ? 'Yes — due in ' + followUpDays + ' days' : 'No'}
- Disqualifier Flag: ${disqualifierReason || 'None'}

Write the HTML email using this exact structure — use inline styles only, Montserrat font, max-width 600px:
1. Outcome banner (blue left border)
2. CONTACT section: Name, Phone
3. CALL SUMMARY section: paragraph with the call summary
4. GHL CHANGES MADE section: table rows for Pipeline, Stage Change, New Contact, New Opportunity, Task Created, Opportunity Value
5. DISQUALIFIER FLAG section: amber left border box (always show, say None if none)

Then write a SHORT plain text Slack message (3-5 lines max) covering: contact name, outcome, key action taken, and any flag.

Return ONLY valid JSON:
{"email_html": "complete HTML string", "slack_message": "plain text slack message"}`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-haiku-4-5-20251001', max_tokens: 2048, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
  );
  const text = response.data.content[0].text;
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function generateEvalEmailContent(params) {
  const { contactName, contactPhone, evaluatingPT, planOfCarePT, outcome, stage, paymentMethod, evaluationSummary, nextSteps, redFlags, calendarCreated, continuityCreated, rehabEssentials, checkinScheduled, objectionCategory, objectionDetail, physicianName, physicianOffice, coachingNotes } = params;

  const prompt = `You are writing post-evaluation summary emails for Movement Clinic Physical Therapy. Based on the data below, write two HTML emails and a Slack message.

EVALUATION DATA:
- Patient: ${contactName} | ${contactPhone}
- Outcome: ${outcome}${stage ? ' — ' + stage : ''}
- Evaluating PT: ${evaluatingPT}
- Plan of Care PT: ${planOfCarePT}
- Payment Method: ${paymentMethod || 'Unclear from transcript'}
- Evaluation Summary: ${evaluationSummary || 'Not available'}
- Next Steps: ${nextSteps || 'Not established'}
- Objection: ${objectionCategory ? objectionCategory + ' — ' + (objectionDetail || '') : 'None'}
- Calendar Appointment Created: ${calendarCreated || 'No'}
- Continuity Pipeline Card Created: ${continuityCreated || 'No'}
- Rehab Essentials Enrolled: ${rehabEssentials || 'No'}
- Check-In Text Scheduled: ${checkinScheduled || 'No'}
- Physician: ${physicianName ? physicianName + (physicianOffice ? ' — ' + physicianOffice : '') : 'None mentioned'}
- Red Flags: ${redFlags || 'None identified'}
- Coaching Notes (Jordan only): ${coachingNotes || 'None'}

Write THREE things:

1. TEAM EMAIL (no coaching notes) — HTML with inline styles, Montserrat font, max 600px:
   - Outcome banner (blue left border)
   - EVALUATION SUMMARY section
   - NEXT STEPS section
   - GHL ACTIONS TAKEN section: table with Payment Method, Calendar Appointment, Continuity Pipeline, Rehab Essentials, Check-In Text, Objection if applicable, Physician if applicable
   - RED FLAGS box (amber left border, always show)

2. JORDAN EMAIL (includes coaching notes) — same as team email but add:
   - COACHING NOTES section at bottom (indigo left border)

3. SLACK MESSAGE — 3-5 lines plain text: patient name, outcome, key action, red flag if any

Return ONLY valid JSON:
{"team_email_html": "complete HTML", "jordan_email_html": "complete HTML with coaching", "slack_message": "plain text"}`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-haiku-4-5-20251001', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
  );
  const text = response.data.content[0].text;
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

function getTimestamp() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }) + ' PT';
}

app.post('/webhook', async (req, res) => {
  const payload = req.body;
  if (payload.type !== 'call.transcript.completed') {
    return res.status(200).json({ message: 'Event ignored' });
  }

  const callObject = payload.data.object;
  const callId = callObject.callId;

  // Dedup: if we've already processed this call ID, ignore the retry
  if (hasProcessedCall(callId)) {
    console.log(`Duplicate webhook ignored for call ${callId}`);
    return res.status(200).json({ message: 'Duplicate call ID, already processed' });
  }
  markCallProcessed(callId);

  const dialogue = callObject.dialogue || [];
  const transcript = dialogue.map(d => d.content).join('\n');

  if (!transcript || transcript.trim().length === 0) {
    return res.status(200).json({ message: 'Empty transcript, skipping' });
  }

  // Return 200 to Quo immediately — prevents Quo from retrying the webhook
  // while processing is still running (which causes duplicate deliveries hours later)
  res.status(200).json({ success: true, message: 'Webhook received, processing async' });

  // All processing runs async after response is sent
  setImmediate(async () => {
    try {

    console.log(`Processing call ${callId}, transcript length: ${transcript.length}`);

    let contactPhone = null;
    let teamMember = null;
    try {
      const callDetails = await getCallDetails(callId);
      contactPhone = extractContactPhone(callDetails);
      teamMember = extractTeamMember(callDetails);
      console.log(`Contact phone: ${contactPhone}, Team member: ${teamMember || 'unknown'}`);
    } catch (err) {
      console.error('Failed to fetch call details:', err.message);
    }

    let contact = null;
    let isNewContact = false;

    if (contactPhone) {
      try {
        contact = await findGHLContact(contactPhone);
      } catch (err) {
        console.error('Failed to find contact:', err.message);
      }
    }

    if (!contact) {
      try {
        const result = await createOrFindGHLContact(contactPhone || '+10000000000', 'Incoming Call No Name Provided');
        contact = result.contact;
        isNewContact = result.isNew;
      } catch (err) {
        console.error('Failed to create/find contact:', err.response?.data || err.message);
        return res.status(500).json({ error: 'Failed to create contact' });
      }
    }

    const isPlaceholderName = !contact.firstName || contact.firstName === 'Incoming Call' || contact.firstName === 'Unknown';
    const contactName = `${contact.firstName || ''} ${contact.lastName || ''}`.trim();
    console.log(`Contact: ${contactName} (${contact.id})`);

    // Find existing lead opportunity - prevents duplicates across lead pipelines
    let allOpps = [];
    try {
      allOpps = await getAllContactOpportunities(contact.id);
    } catch (err) {
      console.error('Failed to fetch opportunities:', err.message);
    }

    const opportunity = findLeadOpportunity(allOpps);
    const isNewOpportunity = !opportunity;

    if (opportunity) {
      console.log(`Found existing lead opportunity: ${opportunity.id} in pipeline ${PIPELINE_NAMES[opportunity.pipelineId]}`);
    }

    const previousPipelineId = opportunity ? opportunity.pipelineId : null;
    const previousStageId = opportunity ? opportunity.pipelineStageId : null;
    const previousValue = opportunity ? opportunity.monetaryValue : null;

    const claudeResult = await analyzeWithClaude(
      transcript,
      previousPipelineId,
      previousStageId,
      isPlaceholderName ? 'Unknown' : contactName
    );

    console.log(`Claude decision: ${claudeResult.outcome}`);

    // Update contact name if extracted from transcript
    let finalContactName = contactName;
    if (claudeResult.extracted_name && isPlaceholderName) {
      const nameParts = claudeResult.extracted_name.trim().split(' ');
      try {
        await updateGHLContactName(contact.id, nameParts[0], nameParts.slice(1).join(' ') || '');
        finalContactName = claudeResult.extracted_name;
        console.log(`Updated contact name to: ${finalContactName}`);
      } catch (err) {
        console.error('Failed to update contact name:', err.message);
      }
    }

    // Determine final pipeline and stage
    let finalPipelineId = claudeResult.new_pipeline_id || previousPipelineId || 'XGWrkugRXEFBP2DJsL9X';
    let finalStageId = claudeResult.new_stage_id;

    // For voicemail and no-contact, advance the day/week progression automatically
    // Guard: only block day/week progression stages — action stages (NEEDS_FOLLOW_UP, ON_HOLD, etc.)
    // always update regardless of how many times a contact is reached in one day
    if (claudeResult.outcome === 'VOICEMAIL' || claudeResult.outcome === 'NO_CONTACT') {
      if (hasAdvancedTodayAlready(contact.id)) {
        console.log(`Stage advancement skipped for ${finalContactName} — already advanced today (additional touchpoint)`);
        finalStageId = previousStageId; // stay on current stage
        claudeResult.action = 'NO_ACTION'; // skip GHL stage update, but note + Slack still fire
      } else {
        const nextStage = getNextStageInProgression(finalPipelineId, previousStageId);
        if (nextStage) {
          finalStageId = nextStage;
          markAdvancedToday(contact.id);
          console.log(`Auto-advancing to next stage: ${STAGE_NAMES[nextStage] || nextStage}`);
        }
      }
    }
    // Action outcomes always clear the same-day advancement guard so a meaningful
    // interaction later in the day can still move the stage
    const ACTION_OUTCOMES = ['EVAL_SCHEDULED', 'NEEDS_FOLLOW_UP', 'ON_HOLD', 'POSSIBLE_DISQUALIFIER', 'WRONG_NUMBER'];
    if (ACTION_OUTCOMES.includes(claudeResult.outcome)) {
      markAdvancedToday(contact.id); // reset so day/week won't fire after an action stage today
    }

    // Create opportunity if none exists — but first check if existing customer
    let activeOpportunity = opportunity;
    if (!activeOpportunity) {
      const customerCheck = await checkExistingCustomer(contact.id, allOpps);

      if (customerCheck.isCustomer) {
        console.log('Existing customer detected — skipping lead pipeline, adding note only');
        let noteTargetOpp = customerCheck.opp;

        // LTV-only match with no Customer Pipeline card — create retroactive card
        if (customerCheck.reason === 'ltv' && !noteTargetOpp) {
          try {
            noteTargetOpp = await createGHLOpportunity(contact.id, EVAL_CUSTOMER_PIPELINE_ID, EVAL_CUSTOMER_STAGES.PACKAGE_PURCHASED, finalContactName || 'Existing Customer');
            await addGHLTag(contact.id, 'Retroactively Added to Customer Pipeline');
            console.log('Created retroactive Customer Pipeline card for LTV customer');
          } catch (err) {
            console.error('Failed to create retroactive customer opportunity:', err.message);
          }
        }

        const ts = getTimestamp();
        const existingNote = 'Claude AI Assistant:\n\n' + ts + '\n\nExisting customer identified (' +
          (customerCheck.reason === 'package_purchased' ? 'Package Purchased in Customer Pipeline' :
           customerCheck.reason === 'continuity' ? 'Active in Continuity Pipeline' :
           'Lifetime value > $' + LTV_CUSTOMER_THRESHOLD) +
          '). No lead pipeline action taken.\n\n' + (claudeResult.note || '');
        await addNoteToContact(contact.id, existingNote);

        await fireGHLSummaryWebhook({
          contact_name: finalContactName || 'Unknown',
          contact_phone: contactPhone || 'Unknown',
          contact_id: contact.id,
          outcome: 'EXISTING CUSTOMER — No Lead Action Taken',
          call_summary: claudeResult.note || '',
          pipeline_stage_info: 'Existing customer — no lead pipeline changes made',
          pipeline_name: 'N/A', previous_stage: 'N/A', new_stage: 'N/A',
          stage_changed: 'No', opportunity_value_previous: 'N/A', opportunity_value_new: 'N/A',
          note_added: 'Yes', new_contact_created: isNewContact ? 'Yes' : 'No',
          new_opportunity_created: customerCheck.reason === 'ltv' ? 'Yes — Retroactive Customer Pipeline' : 'No',
          name_extracted_from_transcript: claudeResult.extracted_name || 'No',
          disqualifier_flag: 'None', follow_up_task_created: 'No', follow_up_days: 'None'
        });

        return res.status(200).json({ success: true, outcome: 'EXISTING_CUSTOMER_NO_ACTION' });
      }

      // Not an existing customer — proceed with lead opportunity creation
      const defaultPipelineId = finalPipelineId;
      const defaultStageId = finalStageId || (PIPELINE_PROGRESSIONS[defaultPipelineId] ? PIPELINE_PROGRESSIONS[defaultPipelineId][0] : 'a43858b6-f06d-4939-8e31-a09739605200');
      try {
        activeOpportunity = await createGHLOpportunity(
          contact.id, defaultPipelineId, defaultStageId,
          finalContactName || 'Incoming Call No Name Provided'
        );
        console.log('Created new lead opportunity: ' + activeOpportunity.id);
      } catch (err) {
        console.error('Failed to create opportunity:', err.response?.data || err.message);
        return res.status(500).json({ error: 'Failed to create opportunity' });
      }
    }

    // Update opportunity stage
    let stageChanged = false;
    if (claudeResult.action === 'UPDATE' && finalStageId) {
      try {
        await updateGHLOpportunity(activeOpportunity.id, finalPipelineId, finalStageId, claudeResult.opportunity_value);
        stageChanged = true;
        console.log(`Updated opportunity to stage: ${STAGE_NAMES[finalStageId] || finalStageId}`);
      } catch (err) {
        console.error('Failed to update opportunity:', err.response?.data || err.message);
      }
    }

    // Build timestamped note
    const timestamp = getTimestamp();
    const noteLines = [
      'Claude AI Assistant:',
      '',
      `📞 Call Summary — ${timestamp}`,
      '',
      `Outcome: ${claudeResult.outcome}`,
      '',
      claudeResult.note
    ];
    if (claudeResult.disqualifier_reason) {
      noteLines.push('');
      noteLines.push(`⚠️ Disqualifier Flag: ${claudeResult.disqualifier_reason}`);
    }
    if (isNewContact) {
      noteLines.push('');
      noteLines.push('ℹ️ New contact created automatically from call transcript.');
    }
    if (isNewOpportunity) {
      noteLines.push('');
      noteLines.push(`ℹ️ New opportunity created in ${PIPELINE_NAMES[finalPipelineId] || finalPipelineId}.`);
    }

    let noteAdded = false;
    try {
      await addNoteToContact(contact.id, noteLines.join('\n'));
      noteAdded = true;
      console.log('Note added to contact');
    } catch (err) {
      console.error('Failed to add note:', err.response?.data || err.message);
    }

    // Create task if follow up timeframe was specified
    let taskCreated = false;
    if (claudeResult.follow_up_days && claudeResult.follow_up_days > 0) {
      try {
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + claudeResult.follow_up_days);
        await createGHLTask(contact.id, TASK_TITLE, dueDate);
        taskCreated = true;
        noteLines.push('ℹ️ Follow-up task created — assigned to Admin Team (info@movementclinicpt.com) — due in ' + claudeResult.follow_up_days + ' days.');
        console.log('Task created with due date in ' + claudeResult.follow_up_days + ' days');
      } catch (err) {
        console.error('Failed to create task:', err.response?.data || err.message);
      }
    }

    // Build pipeline/stage summary for email — plain text, no newlines
    let pipelineStageInfo = '';
    if (isNewOpportunity) {
      pipelineStageInfo = 'Added to pipeline: ' + (PIPELINE_NAMES[finalPipelineId] || finalPipelineId) + ' | Starting stage: ' + (STAGE_NAMES[finalStageId] || finalStageId || 'New Lead');
    } else if (stageChanged) {
      pipelineStageInfo = 'Pipeline: ' + (PIPELINE_NAMES[finalPipelineId] || finalPipelineId) + ' | Stage: ' + (STAGE_NAMES[previousStageId] || 'Unknown') + ' to ' + (STAGE_NAMES[finalStageId] || finalStageId);
    } else {
      pipelineStageInfo = 'Pipeline: ' + (PIPELINE_NAMES[finalPipelineId] || finalPipelineId) + ' | Stage: ' + (STAGE_NAMES[previousStageId] || 'Unknown') + ' (no change)';
    }

    // Build stage display string
    const stageSuppressed = claudeResult.action === 'NO_ACTION' &&
      (claudeResult.outcome === 'VOICEMAIL' || claudeResult.outcome === 'NO_CONTACT');

    const stageDisplay = stageChanged
      ? `${STAGE_NAMES[previousStageId] || 'Unknown'} → ${STAGE_NAMES[finalStageId] || finalStageId}`
      : stageSuppressed
        ? `${STAGE_NAMES[previousStageId] || 'Current stage'} (no change — additional touchpoint today)`
        : (claudeResult.outcome === 'VOICEMAIL' || claudeResult.outcome === 'NO_CONTACT')
          ? `Auto-advanced → ${STAGE_NAMES[finalStageId] || finalStageId}`
          : `${STAGE_NAMES[previousStageId] || 'Current stage'} (no stage change)`;

    // Slack fires FIRST — before email generation or GHL summary webhook
    // Never blocked by downstream API calls
    const callBlocks = buildCallSlackBlocks({
      contactName: finalContactName || 'Unknown',
      contactPhone: contactPhone || 'Unknown',
      callTime: getTimestamp(),
      teamMember: teamMember || 'Not identified',
      outcome: claudeResult.outcome || 'Unknown',
      note: claudeResult.note || '',
      pipeline: PIPELINE_NAMES[finalPipelineId] || finalPipelineId || 'Unknown',
      stageDisplay,
      redFlags: claudeResult.disqualifier_reason || 'None',
      isNewOpportunity,
      confidenceScore: claudeResult.confidence_score || 0,
      confidenceReason: claudeResult.confidence_reason || '',
      contactId: contact.id
    });

    await sendSlackMessage(PIPELINE_MANAGER_CHANNEL, callBlocks);

    // Email generation + GHL summary webhook fire after Slack — non-blocking for team visibility
    try {
      const emailContent = await generateCallEmailContent({
        contactName: finalContactName || 'Unknown',
        contactPhone: contactPhone || 'Unknown',
        outcome: claudeResult.outcome || '',
        note: claudeResult.note || '',
        pipelineName: PIPELINE_NAMES[finalPipelineId] || finalPipelineId || '',
        previousStage: STAGE_NAMES[previousStageId] || 'Unknown',
        newStage: STAGE_NAMES[finalStageId] || finalStageId || '',
        stageChanged,
        opportunityValue: claudeResult.opportunity_value ? '$' + claudeResult.opportunity_value : null,
        disqualifierReason: claudeResult.disqualifier_reason || null,
        isNewContact,
        isNewOpportunity,
        taskCreated,
        followUpDays: claudeResult.follow_up_days || null,
        nameExtracted: claudeResult.extracted_name || null
      });
      await fireGHLSummaryWebhook({
        email_body: emailContent.email_html || '',
        slack_message: emailContent.slack_message || '',
        contact_name: String(finalContactName || 'Unknown'),
        contact_id: String(contact.id || '')
      });
    } catch (emailErr) {
      console.error('Failed to generate email content — full error:', JSON.stringify(emailErr.message || emailErr.response?.data || emailErr));
      await fireGHLSummaryWebhook({
        email_body: '<p>Call processed. Outcome: ' + (claudeResult.outcome || 'Unknown') + '. Contact: ' + (finalContactName || 'Unknown') + '.</p>',
        slack_message: 'Call processed for ' + (finalContactName || 'Unknown') + '. Outcome: ' + (claudeResult.outcome || 'Unknown'),
        contact_name: String(finalContactName || 'Unknown'),
        contact_id: String(contact.id || '')
      });
    }

    // Low confidence handling — if < 80% and a GHL change was made, create a task for review
    const confidenceScore = parseInt(claudeResult.confidence_score) || 0;
    const ghlChangeWasMade = stageChanged || isNewOpportunity;
    if (confidenceScore < 80 && ghlChangeWasMade) {
      const nameParts = (finalContactName || 'Unknown').split(' ');
      const taskTitle = `Low Confidence in Transcript — ${capitalizeFullName(finalContactName)}`;
      const taskNotes = [
        `Confidence Score: ${confidenceScore}%`,
        `Reason: ${claudeResult.confidence_reason || 'Not provided'}`,
        `Pipeline: ${PIPELINE_NAMES[finalPipelineId] || finalPipelineId}`,
        `Stage: ${STAGE_NAMES[previousStageId] || 'Unknown'} → ${STAGE_NAMES[finalStageId] || 'Unknown'}`,
        `Outcome Applied: ${claudeResult.outcome}`,
        `New Opportunity Created: ${isNewOpportunity ? 'Yes' : 'No'}`,
        `Stage Changed: ${stageChanged ? 'Yes' : 'No'}`,
        `Action Required: Review GHL and verify the pipeline changes are correct.`
      ].join('\n');
      try {
        const reviewDueDate = new Date();
        reviewDueDate.setDate(reviewDueDate.getDate() + 1);
        await createGHLTask(contact.id, taskTitle, reviewDueDate);
        console.log(`Low confidence task created for ${finalContactName}`);
      } catch (taskErr) {
        console.error('Failed to create low confidence task:', taskErr.message);
      }
    } else if (confidenceScore < 80 && !ghlChangeWasMade) {
      // Note only — add low confidence flag to the note
      try {
        await addNoteToContact(contact.id, `⚠️ Low Confidence in Transcript Interpretation (${confidenceScore}%) — no GHL changes were made. Manual review recommended.`);
      } catch (noteErr) {
        console.error('Failed to add low confidence note:', noteErr.message);
      }
    }

    console.log(`Successfully processed call ${callId}: ${claudeResult.outcome} (confidence: ${confidenceScore}%)`);

  } catch (error) {
    console.error('Error processing webhook:', error.response?.data || error.message);
  }
  }); // end setImmediate
});

// SMS webhook handler
app.post('/sms', async (req, res) => {
  try {
    const payload = req.body;
    if (payload.type !== 'message.received') {
      return res.status(200).json({ message: 'Event ignored' });
    }

    const messageData = payload.data?.object;
    if (!messageData) return res.status(200).json({ message: 'No message data' });

    const messageBody = messageData.body || messageData.text || '';
    const fromPhone = messageData.from || messageData.participants?.find(p => !CLINIC_PHONE_NUMBERS.includes(p));

    if (!messageBody || !fromPhone) {
      return res.status(200).json({ message: 'Missing message body or phone' });
    }

    console.log(`Processing SMS from ${fromPhone}: ${messageBody}`);

    // Analyze SMS with Claude
    const smsPrompt = `You are a CRM assistant for Movement Clinic Physical Therapy. Analyze this inbound SMS reply from a lead.

SMS MESSAGE: "${messageBody}"

Determine if this message is:
1. DISENGAGEMENT - clear "not interested", "stop", "remove me", "unsubscribe", "no thanks", or similar
2. FUTURE_FOLLOWUP - they want to be contacted at a specific future time ("call me in 2 months", "reach out in January", "not ready until spring", "check back in 6 weeks")
3. IGNORE - anything else (questions, neutral replies, partial interest, "ok", "thanks", etc.)

If FUTURE_FOLLOWUP, extract the number of days from today until the requested follow-up date.

RETURN ONLY valid JSON:
{"action":"DISENGAGEMENT or FUTURE_FOLLOWUP or IGNORE","note":"one sentence summary of what the contact said","follow_up_days":null}`;

    const smsResponse = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5-20251001', max_tokens: 256, messages: [{ role: 'user', content: smsPrompt }] },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
    );

    const smsText = smsResponse.data.content[0].text;
    const smsResult = JSON.parse(smsText.replace(/```json|```/g, '').trim());

    console.log(`SMS analysis: ${smsResult.action}`);

    if (smsResult.action === 'IGNORE') {
      return res.status(200).json({ message: 'SMS ignored' });
    }

    // Look up contact
    let contact = null;
    try {
      contact = await findGHLContact(fromPhone);
    } catch (err) {
      console.error('Failed to find contact for SMS:', err.message);
    }

    if (!contact) {
      console.log('No contact found for SMS, skipping');
      return res.status(200).json({ message: 'No contact found' });
    }

    const allOpps = await getAllContactOpportunities(contact.id);
    const opportunity = findLeadOpportunity(allOpps);

    const timestamp = getTimestamp();
    const noteText = `💬 SMS Reply — ${timestamp}\n\nAction: ${smsResult.action}\n\n${smsResult.note}`;

    await addNoteToContact(contact.id, noteText);

    if (smsResult.action === 'DISENGAGEMENT' && opportunity) {
      const noResponseStages = {
        'TRrXnPy4hAeLDGwMNqrl': 'ef34ca02-6eaf-44d4-b25d-b122ec6cd125',
        '33yDa3WUaypShfeza92G': '9c8485cd-7406-467c-8372-f419ed20a00a',
        'kliYrSoSB5MF75T4R84B': '26876edc-870c-4351-b1df-7589ac8984be',
        'KmePcT4T1I6DL9w5pyBm': '420aed72-b351-41ce-8969-1c93de9c6592',
        'XGWrkugRXEFBP2DJsL9X': '0b4dcfa9-b146-4e17-941b-75dae8e3bed1',
        'F38gCGLVybaU0Sf72J68': 'd02ef914-33a7-4d4a-b800-39da37bf5627',
        'FyMN20G4jUAhNiDmhRXS': '52600431-8a1a-4ef4-8aae-cca6eb690455'
      };
      const noResponseStageId = noResponseStages[opportunity.pipelineId];
      if (noResponseStageId) {
        await updateGHLOpportunity(opportunity.id, opportunity.pipelineId, noResponseStageId, null);
        console.log('Moved to No Response stage — explicit SMS disengagement');
      }
    }

    if (smsResult.action === 'FUTURE_FOLLOWUP' && smsResult.follow_up_days && opportunity) {
      // Move to On Hold stage
      const onHoldStages = {
        'TRrXnPy4hAeLDGwMNqrl': '5cd82fda-e4a2-4017-8fa5-7e057f050f8f',
        'kliYrSoSB5MF75T4R84B': '01421111-996d-4a05-864a-20a67d79b2e1',
        'KmePcT4T1I6DL9w5pyBm': '379a6e20-a2a3-4087-99a6-42bb2bb7c2a2',
        'XGWrkugRXEFBP2DJsL9X': 'bee31474-bfdd-4366-93e7-d7190af8208a',
        'F38gCGLVybaU0Sf72J68': 'd2429fa0-2c21-44f3-9b53-8acc9664fe49',
        'FyMN20G4jUAhNiDmhRXS': 'b36ad65f-ef7d-45c5-b323-8234de779e7d'
      };
      const onHoldStageId = onHoldStages[opportunity.pipelineId];
      if (onHoldStageId) {
        await updateGHLOpportunity(opportunity.id, opportunity.pipelineId, onHoldStageId, null);
        console.log('Moved to On Hold stage');
      }

      // Create follow up task
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + smsResult.follow_up_days);
      await createGHLTask(contact.id, TASK_TITLE, dueDate);
      console.log(`Follow up task created for ${smsResult.follow_up_days} days from now`);
    }

    // Fire summary webhook to GHL for SMS-triggered changes
    if (smsResult.action !== 'IGNORE') {
      const smsContactName = `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || 'Unknown';
      const smsPipelineId = opportunity ? opportunity.pipelineId : null;
      const smsPreviousStageId = opportunity ? opportunity.pipelineStageId : null;

      let smsNewStageId = null;
      if (smsResult.action === 'DISENGAGEMENT' && opportunity) {
        const noResponseStages = {
          'TRrXnPy4hAeLDGwMNqrl': 'ef34ca02-6eaf-44d4-b25d-b122ec6cd125',
          '33yDa3WUaypShfeza92G': '9c8485cd-7406-467c-8372-f419ed20a00a',
          'kliYrSoSB5MF75T4R84B': '26876edc-870c-4351-b1df-7589ac8984be',
          'KmePcT4T1I6DL9w5pyBm': '420aed72-b351-41ce-8969-1c93de9c6592',
          'XGWrkugRXEFBP2DJsL9X': '0b4dcfa9-b146-4e17-941b-75dae8e3bed1',
          'F38gCGLVybaU0Sf72J68': 'd02ef914-33a7-4d4a-b800-39da37bf5627',
          'FyMN20G4jUAhNiDmhRXS': '52600431-8a1a-4ef4-8aae-cca6eb690455'
        };
        smsNewStageId = noResponseStages[smsPipelineId] || null;
      }
      if (smsResult.action === 'FUTURE_FOLLOWUP' && opportunity) {
        const onHoldStages = {
          'TRrXnPy4hAeLDGwMNqrl': '5cd82fda-e4a2-4017-8fa5-7e057f050f8f',
          'kliYrSoSB5MF75T4R84B': '01421111-996d-4a05-864a-20a67d79b2e1',
          'KmePcT4T1I6DL9w5pyBm': '379a6e20-a2a3-4087-99a6-42bb2bb7c2a2',
          'XGWrkugRXEFBP2DJsL9X': 'bee31474-bfdd-4366-93e7-d7190af8208a',
          'F38gCGLVybaU0Sf72J68': 'd2429fa0-2c21-44f3-9b53-8acc9664fe49',
          'FyMN20G4jUAhNiDmhRXS': 'b36ad65f-ef7d-45c5-b323-8234de779e7d'
        };
        smsNewStageId = onHoldStages[smsPipelineId] || null;
      }

      await fireGHLSummaryWebhook({
        contact_name: smsContactName,
        contact_phone: fromPhone || 'Unknown',
        contact_id: contact.id,
        outcome: 'SMS — ' + smsResult.action,
        call_summary: smsResult.note,
        pipeline_stage_info: smsPipelineId
          ? 'Pipeline: ' + (PIPELINE_NAMES[smsPipelineId] || smsPipelineId) + ' | Stage: ' + (STAGE_NAMES[smsPreviousStageId] || 'Unknown') + ' to ' + (smsNewStageId ? (STAGE_NAMES[smsNewStageId] || smsNewStageId) : 'No change')
          : 'No pipeline found',
        pipeline_name: PIPELINE_NAMES[smsPipelineId] || 'Unknown',
        previous_stage: STAGE_NAMES[smsPreviousStageId] || 'Unknown',
        new_stage: smsNewStageId ? (STAGE_NAMES[smsNewStageId] || smsNewStageId) : 'No change',
        stage_changed: smsNewStageId ? 'Yes' : 'No',
        opportunity_value_previous: 'N/A',
        opportunity_value_new: 'N/A',
        note_added: 'Yes',
        new_contact_created: 'No',
        new_opportunity_created: 'No',
        name_extracted_from_transcript: 'N/A',
        disqualifier_flag: 'None',
        follow_up_task_created: smsResult.action === 'FUTURE_FOLLOWUP' ? 'Yes' : 'No',
        follow_up_days: smsResult.follow_up_days ? smsResult.follow_up_days + ' days' : 'None'
      });
    }

    res.status(200).json({ success: true, action: smsResult.action });

  } catch (error) {
    console.error('Error processing SMS:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Update Source of Truth Google Doc ──────────────────────────────────────
// Called automatically after every index.js or index-daily-briefing.js deploy
// PIN protected — same PIN as briefing
const SOT_DOC_ID = process.env.SOT_DOC_ID || '1FzeapjDGbuqvjnToalVlY5p8iEy4-VQKXB2lHLZEIY4';

app.post('/update-sot', async (req, res) => {
  const pin = req.headers['x-briefing-pin'] || req.body?.pin;
  if (pin !== BRIEFING_PIN) return res.status(403).json({ error: 'Forbidden' });

  const { section, content: updateContent } = req.body;
  if (!section || !updateContent) return res.status(400).json({ error: 'Missing section or content' });

  try {
    const { google } = require('googleapis');
    const SERVICE_ACCOUNT_JSON = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
    if (!SERVICE_ACCOUNT_JSON.client_email) throw new Error('No service account configured');

    const auth = new google.auth.JWT({
      email: SERVICE_ACCOUNT_JSON.client_email,
      key: SERVICE_ACCOUNT_JSON.private_key,
      scopes: ['https://www.googleapis.com/auth/documents'],
    });
    await auth.authorize();
    const docs = google.docs({ version: 'v1', auth });

    // Read current doc to find end index
    const doc = await docs.documents.get({ documentId: SOT_DOC_ID });
    const endIndex = doc.data.body.content.reduce((max, el) => {
      return el.endIndex ? Math.max(max, el.endIndex) : max;
    }, 1);

    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric',
      year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
    }) + ' PT';

    const insertText = `\n\n--- ${section} | Updated ${timestamp} ---\n${updateContent}`;

    await docs.documents.batchUpdate({
      documentId: SOT_DOC_ID,
      requestBody: {
        requests: [{
          insertText: { location: { index: endIndex - 1 }, text: insertText }
        }]
      }
    });

    console.log(`SOT updated: ${section}`);
    res.json({ ok: true, section, timestamp });
  } catch (err) {
    console.error('SOT update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /notion-debug?pin=2365 — inspect raw Notion API response for first page
app.get('/notion-debug', async (req, res) => {
  if (req.query.pin !== '2365') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = process.env.NOTION_TOKEN;
    const resp = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_CONVERSIONS_DB}/query`,
      { page_size: 1 },
      { headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
    );
    const page = resp.data.results[0];
    if (!page) return res.json({ error: 'No pages found' });
    const propSummary = {};
    for (const [key, val] of Object.entries(page.properties)) {
      propSummary[key] = { type: val.type, raw: val[val.type] };
    }
    res.json({ totalResults: resp.data.results.length, hasMore: resp.data.has_more, properties: propSummary });
  } catch(e) {
    res.status(500).json({ error: e.message, detail: e.response?.data });
  }
});

// POST /dashboard/auth — validate PIN and set session cookie
app.post('/dashboard/auth', express.urlencoded({ extended: false }), (req, res) => {
  const { pin } = req.body;
  if (pin !== '2365') {
    return res.send(`<!DOCTYPE html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Montserrat',sans-serif;background:#F7F8FA;display:flex;align-items:center;justify-content:center;height:100vh}.box{text-align:center;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:40px 48px}.lock{font-size:36px;margin-bottom:16px}.title{font-size:15px;font-weight:700;color:#232323;margin-bottom:6px}.sub{font-size:12px;color:#6b7280;margin-bottom:24px}.err{font-size:12px;color:#dc2626;margin-bottom:16px;font-weight:600}input{display:block;width:100%;padding:10px 14px;border:1px solid #e5e7eb;border-radius:6px;font-family:'Montserrat',sans-serif;font-size:13px;margin-bottom:10px}input:focus{outline:none;border-color:#0065A3}button{width:100%;padding:10px;background:#232323;color:#fff;border:none;border-radius:6px;font-family:'Montserrat',sans-serif;font-size:13px;font-weight:700;cursor:pointer}button:hover{background:#0065A3}</style>
</head><body><div class="box">
<div class="lock">🔒</div>
<div class="title">Movement Clinic Dashboard</div>
<div class="sub">Enter your PIN to continue</div>
<div class="err">Incorrect PIN — try again</div>
<form method="POST" action="/dashboard/auth">
<input type="password" name="pin" placeholder="PIN" autofocus>
<button type="submit">Unlock</button>
</form></div></body></html>`);
  }
  res.setHeader('Set-Cookie', 'dashboard_auth=2365; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=28800');
  res.redirect('/dashboard');
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /dashboard-data — returns all clinic metrics as JSON (PIN protected)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/dashboard-data', async (req, res) => {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
  if (cookies.dashboard_auth !== '2365') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sheets = getGoogleSheetsClient();
    const SHEET_ID = CLINIC_METRICS_SHEET_ID;
    const PT_LIST = ['Chris Bostwick', 'TJ Aquino', 'John Gan', 'Jordan McCormack'];
    const YEARS = [2021, 2022, 2023, 2024, 2025, 2026];
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // Fetch all tabs in one batch
    const tabNames = [CLINIC_TAB, ...Object.values(PT_TABS)];
    const ranges = tabNames.map(t => `'${t}'!A1:H200`);
    const batchResult = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SHEET_ID, ranges });
    const tabData = {};
    batchResult.data.valueRanges.forEach((vr, i) => {
      tabData[tabNames[i]] = vr.values || [];
    });

    function cellVal(rows, rowIdx, colLetter) {
      const colIdx = colLetter.charCodeAt(0) - 65; // A=0, B=1...
      const row = rows[rowIdx - 1];
      if (!row) return null;
      const v = row[colIdx];
      return v !== undefined && v !== '' ? Number(v) || 0 : null;
    }

    function monthlyVal(rows, anchor, monthName, year) {
      const monthOffset = MONTH_ROWS[monthName];
      if (!monthOffset) return null;
      const row = anchor.dataStartRow + monthOffset - 1;
      const col = yearToCol(year);
      return cellVal(rows, row, col);
    }

    function weeklyVals(rows, anchor, monthName) {
      const monthOffset = MONTH_ROWS[monthName];
      if (!monthOffset) return [null, null, null, null, null];
      const row = anchor.dataStartRow + monthOffset - 1;
      return ['B','C','D','E','F'].map(col => cellVal(rows, row, col));
    }

    // Fetch Notion conversions
    let notionConvData = {};
    try { notionConvData = await getAllConversions(); } catch(e) { console.error('Notion fetch failed:', e.message); }
    const MF = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    function nc(month, year) {
      const idx = MONTHS.indexOf(month);
      return idx !== -1 ? (notionConvData[MF[idx] + ' ' + year] || { clinic: 0, pts: {} }) : { clinic: 0, pts: {} };
    }

    // Build monthly data per PT and clinic
    const data = { clinic: {}, pts: {}, meta: { generatedAt: new Date().toISOString() } };

    // Clinic tab
    const clinicRows = tabData[CLINIC_TAB];
    data.clinic = {};
    for (const month of MONTHS) {
      data.clinic[month] = {};
      for (const year of YEARS) {
        const leads     = monthlyVal(clinicRows, TABLE_ANCHORS.clinic.totalLeads, month, year);
        const evals     = monthlyVal(clinicRows, TABLE_ANCHORS.clinic.totalEvals, month, year);
        const convs     = nc(month, year).clinic || 0;
        const visits    = monthlyVal(clinicRows, TABLE_ANCHORS.clinic.totalVisits, month, year);
        const over24    = monthlyVal(clinicRows, TABLE_ANCHORS.clinic.totalCancels24hr, month, year);
        const late      = monthlyVal(clinicRows, TABLE_ANCHORS.clinic.totalLateCancels, month, year);
        const charts    = weeklyVals(clinicRows, TABLE_ANCHORS.clinic.totalOpenCharts, month);
        const tasks     = weeklyVals(clinicRows, TABLE_ANCHORS.clinic.totalOverdueTasks, month);
        if ([leads,evals,visits,over24,late].every(v => v === null)) continue;
        data.clinic[month][year] = { leads, evals, convs, visits, over24, late, charts, tasks };
      }
    }

    // PT tabs
    for (const pt of PT_LIST) {
      const tab = PT_TABS[pt];
      const rows = tabData[tab];
      data.pts[pt] = {};
      for (const month of MONTHS) {
        data.pts[pt][month] = {};
        for (const year of YEARS) {
          const anchors = TABLE_ANCHORS.pt;
          const evals  = monthlyVal(rows, anchors.totalEvals, month, year);
          const convs  = nc(month, year).pts[pt] || 0;
          const visits = monthlyVal(rows, anchors.totalVisits, month, year);
          const over24 = monthlyVal(rows, anchors.totalCancels24hr, month, year);
          const late   = monthlyVal(rows, anchors.totalLateCancels, month, year);
          const charts = weeklyVals(rows, anchors.totalOpenCharts, month);
          const tasks  = weeklyVals(rows, anchors.totalOverdueTasks, month);
          if ([evals,visits,over24,late].every(v => v === null)) continue;
          data.pts[pt][month][year] = { evals, convs, visits, over24, late, charts, tasks };
        }
      }
    }

    res.json(data);
  } catch (err) {
    console.error('Dashboard data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /dashboard — live HTML dashboard (PIN protected)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/dashboard', async (req, res) => {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
  if (cookies.dashboard_auth !== '2365') {
    return res.send(`<!DOCTYPE html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Montserrat',sans-serif;background:#F7F8FA;display:flex;align-items:center;justify-content:center;height:100vh}.box{text-align:center;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:40px 48px}.lock{font-size:36px;margin-bottom:16px}.title{font-size:15px;font-weight:700;color:#232323;margin-bottom:6px}.sub{font-size:12px;color:#6b7280;margin-bottom:24px}input{display:block;width:100%;padding:10px 14px;border:1px solid #e5e7eb;border-radius:6px;font-family:'Montserrat',sans-serif;font-size:13px;margin-bottom:10px}input:focus{outline:none;border-color:#0065A3}button{width:100%;padding:10px;background:#232323;color:#fff;border:none;border-radius:6px;font-family:'Montserrat',sans-serif;font-size:13px;font-weight:700;cursor:pointer}button:hover{background:#0065A3}</style>
</head><body><div class="box">
<div class="lock">🔒</div>
<div class="title">Movement Clinic Dashboard</div>
<div class="sub">Enter your PIN to continue</div>
<form method="POST" action="/dashboard/auth">
<input type="password" name="pin" placeholder="PIN" autofocus>
<button type="submit">Unlock</button>
</form></div></body></html>`);
  }

  try {
    const sheets = getGoogleSheetsClient();
    const YEARS = [2021,2022,2023,2024,2025,2026];
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const PT_LIST = ['Chris Bostwick','TJ Aquino','John Gan','Jordan McCormack'];
    const PIN = '2365';

    // Fetch all sheet data
    const tabNames = [CLINIC_TAB, ...Object.values(PT_TABS)];
    const batchResult = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: CLINIC_METRICS_SHEET_ID,
      ranges: tabNames.map(t => `'${t}'!A1:H200`)
    });
    const tabData = {};
    batchResult.data.valueRanges.forEach((vr, i) => { tabData[tabNames[i]] = vr.values || []; });

    function cellVal(rows, rowIdx, colLetter) {
      const colIdx = colLetter.charCodeAt(0) - 65;
      const row = rows[rowIdx - 1];
      if (!row) return null;
      const v = row[colIdx];
      return v !== undefined && v !== '' ? (Number(v) || 0) : null;
    }
    function monthlyVal(rows, anchor, monthName, year) {
      const mo = MONTH_ROWS[monthName]; if (!mo) return null;
      return cellVal(rows, anchor.dataStartRow + mo - 1, yearToCol(year));
    }
    function weeklyVals(rows, anchor, monthName) {
      const mo = MONTH_ROWS[monthName]; if (!mo) return [null,null,null,null,null];
      const row = anchor.dataStartRow + mo - 1;
      return ['B','C','D','E','F'].map(col => cellVal(rows, row, col));
    }
    function lastWeekVal(vals) {
      for (let i = vals.length - 1; i >= 0; i--) { if (vals[i] !== null) return vals[i]; }
      return 0;
    }

    // Find current month/year with data
    const now = new Date();
    let curYear = now.getFullYear(), curMonthIdx = now.getMonth();
    const curMonth = MONTHS[curMonthIdx];
    const clinicRows = tabData[CLINIC_TAB];

    // Load latest metrics snapshot (written on each /metrics/submit)
    let latestMetrics = null;
    try {
      const metricsPath = require('path').join(require('fs').existsSync('/data') ? '/data' : '/tmp', 'latest-metrics.json');
      if (require('fs').existsSync(metricsPath)) {
        latestMetrics = JSON.parse(require('fs').readFileSync(metricsPath, 'utf8'));
      }
    } catch(e) { console.error('Failed to load latest-metrics.json:', e.message); }

    // Fetch Notion conversion data (Package Purchased only)
    let notionConversions = {};
    try {
      notionConversions = await getNotionConversions();
    } catch(e) {
      console.error('Notion fetch failed in dashboard:', e.message);
    }

    const MONTH_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    function notionConvForMonth(month, year) {
      const idx = MONTHS.indexOf(month);
      if (idx === -1) return { clinic: 0, pts: {}, pendingVisit: 0, pendingCall: 0, pendingNotion: 0 };
      const key = MONTH_FULL[idx] + ' ' + year;
      return notionConversions[key] || { clinic: 0, pts: {}, pendingVisit: 0, pendingCall: 0, pendingNotion: 0 };
    }

    // Pull current month data per PT
    function getPTMonth(pt, month, year) {
      const rows = tabData[PT_TABS[pt]];
      const a = TABLE_ANCHORS.pt;
      const nc = notionConvForMonth(month, year);
      // Pull continuity, complimentary, schedEff from latest snapshot if month/year matches
      const isCurrentSnap = latestMetrics && latestMetrics.month === month && latestMetrics.year === year;
      const snapPT = isCurrentSnap && latestMetrics.visitData ? latestMetrics.visitData[pt] : null;
      const schedEff = isCurrentSnap && latestMetrics.schedEfficiency ? latestMetrics.schedEfficiency[pt] : null;
      return {
        evals:         monthlyVal(rows, a.totalEvals, month, year) || 0,
        convs:         nc.pts[pt] || 0,
        visits:        monthlyVal(rows, a.totalVisits, month, year) || 0,
        over24:        monthlyVal(rows, a.totalCancels24hr, month, year) || 0,
        late:          monthlyVal(rows, a.totalLateCancels, month, year) || 0,
        charts:        lastWeekVal(weeklyVals(rows, a.totalOpenCharts, month)),
        tasks:         lastWeekVal(weeklyVals(rows, a.totalOverdueTasks, month)),
        continuity:    snapPT ? snapPT.continuity : null,
        complimentary: snapPT ? snapPT.complimentary : null,
        schedEff:      schedEff !== null ? schedEff : null,
        pendingVisit:  nc.pendingVisit || 0,
        pendingCall:   nc.pendingCall || 0,
        pendingNotion: nc.pendingNotion || 0,
      };
    }

    function getClinicMonth(month, year) {
      const a = TABLE_ANCHORS.clinic;
      const nc = notionConvForMonth(month, year);
      return {
        leads:        monthlyVal(clinicRows, a.totalLeads, month, year) || 0,
        evals:        monthlyVal(clinicRows, a.totalEvals, month, year) || 0,
        convs:        nc.clinic || 0,
        visits:       monthlyVal(clinicRows, a.totalVisits, month, year) || 0,
        over24:       monthlyVal(clinicRows, a.totalCancels24hr, month, year) || 0,
        late:         monthlyVal(clinicRows, a.totalLateCancels, month, year) || 0,
        charts:       lastWeekVal(weeklyVals(clinicRows, a.totalOpenCharts, month)),
        tasks:        lastWeekVal(weeklyVals(clinicRows, a.totalOverdueTasks, month)),
        pendingVisit:  nc.pendingVisit || 0,
        pendingCall:   nc.pendingCall || 0,
        pendingNotion: nc.pendingNotion || 0,
      };
    }

    function cancelRate(d) {
      if (!d.visits) return null;
      return ((d.over24 + d.late) / d.visits * 100);
    }
    function cancelBadge(rate) {
      if (rate === null) return '<span style="color:#6b7280">—</span>';
      const pct = rate.toFixed(1) + '%';
      if (rate >= 15) return `<span class="badge red">${pct}</span>`;
      if (rate >= 13) return `<span class="badge yellow">${pct}</span>`;
      return `<span class="badge green">${pct}</span>`;
    }
    function convRate(d) {
      if (!d.evals) return null;
      return (d.convs / d.evals * 100);
    }
    function convBadge(rate) {
      if (rate === null) return '<span style="color:#6b7280">—</span>';
      const pct = rate.toFixed(0) + '%';
      if (rate >= 70) return `<span class="badge green">${pct}</span>`;
      if (rate >= 50) return `<span class="badge yellow">${pct}</span>`;
      return `<span class="badge red">${pct}</span>`;
    }
    function effBadge(pct) {
      if (pct === null) return '<span style="color:#6b7280">—</span>';
      const s = pct.toFixed(1) + '%';
      if (pct >= 85) return `<span class="badge green">${s}</span>`;
      if (pct >= 70) return `<span class="badge yellow">${s}</span>`;
      return `<span class="badge red">${s}</span>`;
    }
    function opt(v, suffix='') { return v !== null ? v + suffix : '<span style="color:#6b7280">—</span>'; }
    function n(v) { return v ?? 0; }

    // Current month PT data
    const ptData = {};
    for (const pt of PT_LIST) ptData[pt] = getPTMonth(pt, curMonth, curYear);
    const clinicCur = getClinicMonth(curMonth, curYear);

    // Clinic excl Jordan (for efficiency)
    const exJordan = ['Chris Bostwick','TJ Aquino','John Gan'];
    const exJVisits = exJordan.reduce((s,pt) => s + ptData[pt].visits, 0);
    const exJCancels = exJordan.reduce((s,pt) => s + ptData[pt].over24 + ptData[pt].late, 0);
    const exJRate = exJVisits ? (exJCancels / exJVisits * 100) : null;

    // Month-over-month table — all months with any data
    const momRows = [];
    for (const year of YEARS) {
      for (const month of MONTHS) {
        const d = getClinicMonth(month, year);
        if (!d.visits && !d.evals) continue;
        const rate = cancelRate(d);
        momRows.push({ month, year, ...d, rate });
      }
    }

    // Year summaries
    const yearSummaries = {};
    for (const year of YEARS) {
      let tot = { visits:0, evals:0, convs:0, over24:0, late:0, leads:0, months:0 };
      for (const month of MONTHS) {
        const d = getClinicMonth(month, year);
        if (!d.visits && !d.evals) continue;
        tot.visits += d.visits; tot.evals += d.evals; tot.convs += d.convs;
        tot.over24 += d.over24; tot.late += d.late; tot.leads += d.leads; tot.months++;
      }
      if (tot.months > 0) yearSummaries[year] = tot;
    }

    const COLORS = { dark:'#232323', yellow:'#FFD70A', blue:'#0065A3', bg:'#F7F8FA', border:'#e5e7eb', mid:'#6b7280' };
    const PT_COLORS = {
      'Chris Bostwick': '#0065A3',
      'TJ Aquino': '#166534',
      'John Gan': '#92400e',
      'Jordan McCormack': '#4b5563'
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Movement Clinic — Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Montserrat','Segoe UI',Arial,sans-serif;background:#F7F8FA;color:#232323;font-size:12px}
.topbar{background:#232323;border-bottom:3px solid #FFD70A;padding:14px 0}
.topbar-inner{max-width:1100px;margin:0 auto;padding:0 40px;display:flex;align-items:center;justify-content:space-between}
.topbar h1{color:#fff;font-size:18px;font-weight:700}
.topbar .sub{color:#9CA3AF;font-size:11px;margin-top:2px}
.tabs{display:flex;gap:0;border-bottom:2px solid #e5e7eb;margin-bottom:28px}
.tab{padding:10px 24px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;cursor:pointer;color:#6b7280;border-bottom:3px solid transparent;margin-bottom:-2px;transition:all .15s}
.tab.active{color:#0065A3;border-bottom-color:#0065A3}
.tab:hover{color:#232323}
.page{display:none}.page.active{display:block}
.container{max-width:1100px;margin:0 auto;padding:0 40px 60px}
.section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:#0065A3;border-bottom:2px solid #0065A3;padding-bottom:5px;margin-bottom:14px;margin-top:28px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px}
.card-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:6px}
.card-name{font-size:13px;font-weight:700;color:#232323;margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid}
.card-row{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #f3f4f6}
.card-row:last-child{border-bottom:none}
.card-key{color:#6b7280;font-weight:500}
.card-val{font-weight:700;color:#232323}
.clinic-card{background:#232323;border-color:#232323;color:#fff}
.clinic-card .card-label{color:#9CA3AF}
.clinic-card .card-name{color:#FFD70A;border-bottom-color:#FFD70A}
.clinic-card .card-key{color:#9CA3AF}
.clinic-card .card-val{color:#fff}
.clinic-card .card-row{border-bottom-color:#333}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700}
.badge.red{background:#fef2f2;color:#dc2626}
.badge.yellow{background:#fffbeb;color:#92400e}
.badge.green{background:#dcfce7;color:#166534}
table{width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:20px}
thead th{background:#232323;color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;padding:8px 12px;text-align:left}
tbody tr:nth-child(even){background:#F7F8FA}
tbody tr:nth-child(odd){background:#fff}
tbody td{padding:7px 12px;font-size:11px;font-weight:500;border-bottom:1px solid #e5e7eb;vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody td:first-child{font-weight:700}
.updated{font-size:10px;color:#9CA3AF;margin-bottom:20px}
.yr-summary{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.yr-card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px}
.yr-card-year{font-size:16px;font-weight:700;color:#232323;margin-bottom:6px}
.yr-card-row{display:flex;justify-content:space-between;font-size:11px;padding:2px 0}
.yr-card-key{color:#6b7280}
.yr-card-val{font-weight:700}
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-inner">
    <div>
      <div style="color:#9CA3AF;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:3px">Movement Clinic Physical Therapy</div>
      <h1>Clinic Performance Dashboard</h1>
    </div>
    <div class="sub">Updated ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</div>
  </div>
</div>

<div class="container" style="padding-top:24px">
  <div class="tabs">
    <div class="tab active" onclick="showPage('weekly')">📋 Weekly Meeting</div>
    <div class="tab" onclick="showPage('mom')">📅 Month over Month</div>
    <div class="tab" onclick="showPage('yoy')">📈 Year over Year</div>
  </div>

  <!-- ══════════════ PAGE 1: WEEKLY MEETING ══════════════ -->
  <div class="page active" id="page-weekly">
    <div class="section-title">${curMonth} ${curYear} — Provider Snapshot</div>

    <!-- Clinic Summary Bar -->
    <div style="background:#232323;border-radius:8px;padding:14px 20px;margin-bottom:20px;display:flex;gap:0;flex-wrap:wrap">
      ${[
        ['Total Leads', n(clinicCur.leads)],
        ['Total Visits', n(clinicCur.visits)],
        ['Total Evals', n(clinicCur.evals)],
        ['Conversions', n(clinicCur.convs)],
        ['Conv Rate', convBadge(convRate(clinicCur))],
        ['Cancel Rate', cancelBadge(exJRate)],
        ['Open Charts', n(clinicCur.charts)],
        ['Overdue Tasks', n(clinicCur.tasks)],
      ].map(([k,v]) => `<div style="flex:1;min-width:100px;padding:6px 16px;border-right:1px solid #333;last-child{border:none}">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#9CA3AF;margin-bottom:4px">${k}</div>
        <div style="font-size:16px;font-weight:700;color:#FFD70A">${v}</div>
      </div>`).join('')}
    </div>

    <!-- Provider Cards -->
    <div class="cards">
      ${[...exJordan, 'Jordan McCormack'].map(pt => {
        const d = ptData[pt];
        const rate = cancelRate(d);
        const cRate = convRate(d);
        const isJordan = pt === 'Jordan McCormack';
        return `<div class="card">
          <div class="card-label">${isJordan ? 'Owner / PT' : 'Physical Therapist'}</div>
          <div class="card-name" style="border-color:${PT_COLORS[pt]}">${pt}</div>
          <div class="card-row"><span class="card-key">Visits</span><span class="card-val">${n(d.visits)}</span></div>
          <div class="card-row"><span class="card-key">Continuity Visits</span><span class="card-val">${opt(d.continuity)}</span></div>
          <div class="card-row"><span class="card-key">Complimentary</span><span class="card-val">${opt(d.complimentary)}</span></div>
          <div class="card-row"><span class="card-key">Evals</span><span class="card-val">${n(d.evals)}</span></div>
          <div class="card-row"><span class="card-key">Conversions</span><span class="card-val">${n(d.convs)}</span></div>
          <div class="card-row"><span class="card-key">Conv Rate</span><span class="card-val">${convBadge(cRate)}</span></div>
          <div class="card-row"><span class="card-key">Sched Efficiency</span><span class="card-val">${effBadge(d.schedEff)}</span></div>
          <div class="card-row"><span class="card-key">Cancel Rate</span><span class="card-val">${cancelBadge(rate)}</span></div>
          <div class="card-row"><span class="card-key">&gt;24hr Cancels</span><span class="card-val">${n(d.over24)}</span></div>
          <div class="card-row"><span class="card-key">Late/No-Show</span><span class="card-val">${n(d.late)}</span></div>
          ${!isJordan ? `<div class="card-row"><span class="card-key">Open Charts</span><span class="card-val">${n(d.charts)}</span></div>
          <div class="card-row"><span class="card-key">Overdue Tasks</span><span class="card-val">${n(d.tasks)}</span></div>` : ''}
        </div>`;
      }).join('')}
    </div>

    <div class="section-title">Visit Breakdown by Provider</div>
    <table>
      <thead><tr>
        <th>Provider</th><th>Visits</th><th>Continuity</th><th>Complimentary</th><th>Evals</th><th>Convs</th><th>Conv %</th><th>Sched Eff</th><th>Cancel Rate</th><th>Open Charts</th><th>Overdue Tasks</th>
      </tr></thead>
      <tbody>
        ${PT_LIST.map(pt => {
          const d = ptData[pt];
          return `<tr>
            <td style="color:${PT_COLORS[pt]}">${pt}</td>
            <td>${n(d.visits)}</td>
            <td>${opt(d.continuity)}</td>
            <td>${opt(d.complimentary)}</td>
            <td>${n(d.evals)}</td>
            <td>${n(d.convs)}</td>
            <td>${n(d.pendingVisit)}</td>
            <td>${n(d.pendingCall)}</td>
            <td>${convBadge(convRate(d))}</td>
            <td>${effBadge(d.schedEff)}</td>
            <td>${cancelBadge(cancelRate(d))}</td>
            <td>${pt !== 'Jordan McCormack' ? n(d.charts) : '—'}</td>
            <td>${pt !== 'Jordan McCormack' ? n(d.tasks) : '—'}</td>
          </tr>`;
        }).join('')}
        <tr style="background:#232323;color:#fff;font-weight:700">
          <td style="color:#FFD70A">Clinic Total</td>
          <td>${n(clinicCur.visits)}</td>
          <td>—</td><td>—</td>
          <td>${n(clinicCur.evals)}</td><td>${n(clinicCur.convs)}</td>
          <td>${n(clinicCur.pendingVisit)}</td><td>${n(clinicCur.pendingCall)}</td>
          <td>${convBadge(convRate(clinicCur))}</td>
          <td>—</td>
          <td>${cancelBadge(exJRate)}</td>
          <td>${n(clinicCur.charts)}</td><td>${n(clinicCur.tasks)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- ══════════════ PAGE 2: MONTH OVER MONTH ══════════════ -->
  <div class="page" id="page-mom">
    <div class="section-title">Month over Month — Clinic Summary</div>
    <table>
      <thead><tr>
        <th>Month</th><th>Year</th><th>Leads</th><th>Visits</th><th>Evals</th><th>Conversions</th><th>&gt;24hr</th><th>Late/NS</th><th>Cancel Rate</th>
      </tr></thead>
      <tbody>
        ${momRows.map((r, i) => {
          const prev = momRows[i - 1];
          const visitChg = prev && prev.visits ? ((r.visits - prev.visits) / prev.visits * 100) : null;
          const rateChg = prev && prev.rate != null && r.rate != null ? (r.rate - prev.rate) : null;
          const chgBadge = (v, invert = false) => {
            if (v === null) return '';
            const good = invert ? v < 0 : v > 0;
            const color = good ? '#166534' : '#dc2626';
            return `<span style="color:${color};font-size:10px;margin-left:4px">${v > 0 ? '▲' : '▼'}${Math.abs(v).toFixed(1)}%</span>`;
          };
          return `<tr>
            <td>${r.month}</td><td>${r.year}</td>
            <td>${n(r.leads)}</td>
            <td>${n(r.visits)}${chgBadge(visitChg)}</td>
            <td>${n(r.evals)}</td>
            <td>${n(r.convs)}</td>
            <td>${n(r.over24)}</td>
            <td>${n(r.late)}</td>
            <td>${cancelBadge(r.rate)}${chgBadge(rateChg, true)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>

    <div class="section-title">Month over Month — By Provider</div>
    ${PT_LIST.map(pt => {
      const ptMomRows = [];
      for (const year of YEARS) {
        for (const month of MONTHS) {
          const d = getPTMonth(pt, month, year);
          if (!d.visits && !d.evals) continue;
          ptMomRows.push({ month, year, ...d, rate: cancelRate(d) });
        }
      }
      if (!ptMomRows.length) return '';
      return `<div style="margin-bottom:20px">
        <div style="font-size:11px;font-weight:700;color:${PT_COLORS[pt]};margin-bottom:8px">${pt}</div>
        <table>
          <thead><tr><th>Month</th><th>Year</th><th>Visits</th><th>Evals</th><th>Convs</th><th>&gt;24hr</th><th>Late/NS</th><th>Cancel Rate</th></tr></thead>
          <tbody>
            ${ptMomRows.map(r => `<tr>
              <td>${r.month}</td><td>${r.year}</td>
              <td>${n(r.visits)}</td><td>${n(r.evals)}</td><td>${n(r.convs)}</td>
              <td>${n(r.over24)}</td><td>${n(r.late)}</td><td>${cancelBadge(r.rate)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    }).join('')}
  </div>

  <!-- ══════════════ PAGE 3: YEAR OVER YEAR ══════════════ -->
  <div class="page" id="page-yoy">
    <div class="section-title">Year over Year — Clinic Totals</div>
    <div class="yr-summary">
      ${Object.entries(yearSummaries).map(([year, d]) => {
        const rate = d.visits ? ((d.over24 + d.late) / d.visits * 100) : null;
        return `<div class="yr-card">
          <div class="yr-card-year">${year}</div>
          <div class="yr-card-row"><span class="yr-card-key">Visits</span><span class="yr-card-val">${n(d.visits)}</span></div>
          <div class="yr-card-row"><span class="yr-card-key">Evals</span><span class="yr-card-val">${n(d.evals)}</span></div>
          <div class="yr-card-row"><span class="yr-card-key">Convs</span><span class="yr-card-val">${n(d.convs)}</span></div>
          <div class="yr-card-row"><span class="yr-card-key">Leads</span><span class="yr-card-val">${n(d.leads)}</span></div>
          <div class="yr-card-row"><span class="yr-card-key">Cancel Rate</span><span class="yr-card-val">${rate !== null ? rate.toFixed(1)+'%' : '—'}</span></div>
          <div class="yr-card-row"><span class="yr-card-key">Months</span><span class="yr-card-val">${d.months}</span></div>
        </div>`;
      }).join('')}
    </div>

    <div class="section-title">Year over Year — Comparison Table</div>
    <table>
      <thead><tr><th>Year</th><th>Total Visits</th><th>Total Evals</th><th>Conversions</th><th>Leads</th><th>Cancels &gt;24hr</th><th>Late/NS</th><th>Cancel Rate</th><th>Months of Data</th></tr></thead>
      <tbody>
        ${Object.entries(yearSummaries).map(([year, d], i, arr) => {
          const rate = d.visits ? ((d.over24 + d.late) / d.visits * 100) : null;
          const prev = i > 0 ? arr[i-1][1] : null;
          const visitGrowth = prev && prev.visits ? ((d.visits - prev.visits) / prev.visits * 100) : null;
          const arrow = (v) => {
            if (v === null) return '';
            const col = v >= 0 ? '#166534' : '#dc2626';
            return `<span style="color:${col};font-size:10px;margin-left:4px">${v >= 0 ? '▲' : '▼'}${Math.abs(v).toFixed(1)}%</span>`;
          };
          return `<tr>
            <td style="font-weight:700">${year}</td>
            <td>${n(d.visits)}${arrow(visitGrowth)}</td>
            <td>${n(d.evals)}</td><td>${n(d.convs)}</td><td>${n(d.leads)}</td>
            <td>${n(d.over24)}</td><td>${n(d.late)}</td>
            <td>${cancelBadge(rate)}</td>
            <td>${d.months}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
</div>

<script>
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  event.target.classList.add('active');
}
</script>
</body></html>`;

    res.send(html);
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).send('<pre>Dashboard error: ' + err.message + '</pre>');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Movement Clinic webhook server running on port ${PORT}`); });

// ============================================================
// DAILY BRIEFING
// ============================================================

const fs = require('fs');
const path = require('path');
// /data is a Railway persistent volume — survives restarts and redeploys.
// Falls back to /tmp if the volume isn't mounted (e.g. local dev).
const BRIEFING_DIR = require('fs').existsSync('/data') ? '/data' : '/tmp';
const BRIEFING_FILE = path.join(BRIEFING_DIR, 'latest-briefing.json');

// File-backed briefing processing flag — survives Railway restarts.
const BRIEFING_FLAG_FILE = require('path').join(BRIEFING_DIR, 'briefing-processing.json');

function getBriefingProcessingState() {
  try {
    if (require('fs').existsSync(BRIEFING_FLAG_FILE)) {
      const data = JSON.parse(require('fs').readFileSync(BRIEFING_FLAG_FILE, 'utf8'));
      // Auto-expire after 10 minutes — if it's been that long, something went wrong
      if (data.startedAt && Date.now() - new Date(data.startedAt).getTime() > 10 * 60 * 1000) {
        require('fs').unlinkSync(BRIEFING_FLAG_FILE);
        return { isProcessing: false, startedAt: null };
      }
      return { isProcessing: data.isProcessing || false, startedAt: data.startedAt || null };
    }
  } catch (e) { /* fall through */ }
  return { isProcessing: false, startedAt: null };
}

function setBriefingProcessing(isProcessing) {
  try {
    if (!isProcessing) {
      if (require('fs').existsSync(BRIEFING_FLAG_FILE)) require('fs').unlinkSync(BRIEFING_FLAG_FILE);
    } else {
      require('fs').writeFileSync(BRIEFING_FLAG_FILE, JSON.stringify({ isProcessing: true, startedAt: new Date().toISOString() }));
    }
  } catch (e) {
    console.error('Failed to set briefing processing flag:', e.message);
  }
}
const BRIEFING_PIN = process.env.BRIEFING_PIN || '2365';
const NOTION_TOKEN_BRIEFING = process.env.NOTION_TOKEN;

// ── Save briefing payload posted by the daily-briefing service ──
app.post('/save-briefing', (req, res) => {
  const pin = req.headers['x-briefing-pin'];
  if (pin !== BRIEFING_PIN) return res.status(403).json({ error: 'Forbidden' });
  try {
    fs.writeFileSync(BRIEFING_FILE, JSON.stringify({ ...req.body, savedAt: new Date().toISOString() }));
    // Clear processing flag — briefing is now saved and ready
    setBriefingProcessing(false);
    console.log('💾 Briefing saved');
    res.json({ ok: true });
  } catch (err) {
    console.error('Save briefing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Mark a Notion task as Done ──
app.post('/mark-done', async (req, res) => {
  const pin = req.headers['x-briefing-pin'] || req.body?.pin;
  if (pin !== BRIEFING_PIN) return res.status(403).json({ error: 'Forbidden' });
  const { notionId } = req.body;
  if (!notionId) return res.status(400).json({ error: 'Missing notionId' });
  try {
    await axios.patch(
      `https://api.notion.com/v1/pages/${notionId}`,
      { properties: { Done: { checkbox: true } } },
      {
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN_BRIEFING}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
      }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Mark done error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Push task to admin ──
// ── Shared helper: create a GHL task assigned to a specific user ──────────────
async function createPushTask(title, notes, notionUrl, contactName, contactPhone, assigneeGhlId) {
  const results = { ghlTask: null, errors: [] };
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 2);

  if (contactPhone) {
    try {
      const cleanPhone = contactPhone.replace(/\D/g, '');
      const contactRes = await axios.get(
        `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${cleanPhone}`,
        { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
      );
      const contact = contactRes.data.contacts?.[0];
      if (contact) {
        await axios.post(
          `https://services.leadconnectorhq.com/contacts/${contact.id}/tasks`,
          { title, body: notes || '', dueDate: dueDate.toISOString(), completed: false, assignedTo: assigneeGhlId },
          { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' } }
        );
        results.ghlTask = `Linked to contact: ${contact.firstName || contactName || contactPhone}`;
      } else {
        results.errors.push('Contact not found in GHL — task not created');
        results.ghlTask = 'No GHL contact match found';
      }
    } catch (err) {
      results.errors.push('GHL task: ' + err.message);
      results.ghlTask = 'GHL task failed';
    }
  } else {
    // No phone — skip GHL task, email will carry the task
    results.ghlTask = 'No contact phone — task sent via email only';
  }

  return results;
}

// ── Shared helper: send task email via Gmail ───────────────────────────────────
async function sendTaskEmail(toEmail, roleLabel, accentColor, title, notes, notionUrl, contactName) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const safeTitle = title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeNotes = notes ? notes.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') : '';
  const safeContact = contactName ? contactName.replace(/</g, '&lt;') : '';

  const emailHtml = `
<div style="font-family:'Montserrat','Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#F7F8FA;">
  <div style="background:#232323;padding:20px 24px;border-bottom:3px solid ${accentColor};">
    <p style="color:#F7F8FA;font-size:13px;font-weight:700;margin:0;letter-spacing:0.5px;">MOVEMENT CLINIC · ${roleLabel} TASK</p>
  </div>
  <div style="padding:24px;">
    <h2 style="font-size:18px;font-weight:700;color:#232323;margin:0 0 16px;">${safeTitle}</h2>
    ${safeContact ? `<p style="font-size:13px;color:#6b7280;margin:0 0 8px;"><strong>Related to:</strong> ${safeContact}</p>` : ''}
    ${safeNotes ? `
    <div style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${accentColor};border-radius:0 8px 8px 0;padding:14px 16px;margin:16px 0;">
      <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin:0 0 8px;">Notes from Jordan</p>
      <p style="font-size:14px;color:#232323;line-height:1.6;margin:0;">${safeNotes}</p>
    </div>` : ''}
    ${notionUrl ? `<p style="margin:16px 0 0;"><a href="${notionUrl}" style="display:inline-block;background:#232323;color:#F7F8FA;padding:9px 18px;border-radius:8px;text-decoration:none;font-size:12px;font-weight:700;letter-spacing:0.5px;">Open in Notion →</a></p>` : ''}
    <p style="font-size:11px;color:#9ca3af;margin:24px 0 0;border-top:1px solid #e5e7eb;padding-top:16px;">Assigned ${today} · Movement Clinic Daily Briefing</p>
  </div>
</div>`;

  const { google } = require('googleapis');
  const SERVICE_ACCOUNT_JSON = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!SERVICE_ACCOUNT_JSON.client_email) throw new Error('No service account configured');

  const auth = new google.auth.JWT({
    email: SERVICE_ACCOUNT_JSON.client_email,
    key: SERVICE_ACCOUNT_JSON.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    subject: process.env.GMAIL_USER,
  });
  await auth.authorize();
  const gmail = google.gmail({ version: 'v1', auth });
  const subject = `Task Assigned: ${title}`;
  const messageParts = [
    `From: ${process.env.GMAIL_USER}`,
    `To: ${toEmail}`,
    `Subject: ${subject}`,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    emailHtml,
  ];
  const raw = Buffer.from(messageParts.join('\n')).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return `Sent to ${toEmail}`;
}

// ── Push to Admin ──────────────────────────────────────────────────────────────
app.post('/push-to-admin', async (req, res) => {
  const pin = req.headers['x-briefing-pin'] || req.body?.pin;
  if (pin !== BRIEFING_PIN) return res.status(403).json({ error: 'Forbidden' });

  const { title, notes, notionUrl, contactName, contactPhone } = req.body;
  if (!title) return res.status(400).json({ error: 'Missing title' });

  const results = { ghlTask: null, email: null, errors: [] };

  // GHL task assigned to admin (TASK_ASSIGNEE_ID = existing admin assignee)
  const taskResults = await createPushTask(title, notes, notionUrl, contactName, contactPhone, TASK_ASSIGNEE_ID);
  results.ghlTask = taskResults.ghlTask;
  results.errors.push(...taskResults.errors);

  // Email to admin
  try {
    results.email = await sendTaskEmail(
      'info@movementclinicpt.com',
      'ADMIN',
      '#0065a3',
      title, notes, notionUrl, contactName
    );
  } catch (emailErr) {
    results.errors.push('Email: ' + emailErr.message);
  }

  res.json({ ok: true, results });
});

// ── Push to Clinic Director (Chris Bostwick) ───────────────────────────────────
app.post('/push-to-director', async (req, res) => {
  const pin = req.headers['x-briefing-pin'] || req.body?.pin;
  if (pin !== BRIEFING_PIN) return res.status(403).json({ error: 'Forbidden' });

  const { title, notes, notionUrl, contactName, contactPhone } = req.body;
  if (!title) return res.status(400).json({ error: 'Missing title' });

  const CHRIS_GHL_ID = 'awm68XlHfnAH8MVMIP4O';
  const CHRIS_EMAIL = 'chris@movementclinicpt.com'; // update if different

  const results = { ghlTask: null, email: null, errors: [] };

  // GHL task assigned to Chris
  const taskResults = await createPushTask(title, notes, notionUrl, contactName, contactPhone, CHRIS_GHL_ID);
  results.ghlTask = taskResults.ghlTask;
  results.errors.push(...taskResults.errors);

  // Email to Chris
  try {
    results.email = await sendTaskEmail(
      CHRIS_EMAIL,
      'CLINIC DIRECTOR',
      '#4b5563',
      title, notes, notionUrl, contactName
    );
  } catch (emailErr) {
    results.errors.push('Email: ' + emailErr.message);
  }

  res.json({ ok: true, results });
});

// ── Manual briefing trigger (proxies to Daily-Briefing service) ──────────────
// Hitting this URL from a browser fires the briefing immediately without
// needing to touch Railway UI. PIN protected.
app.get('/run-briefing', async (req, res) => {
  if (req.query.pin !== BRIEFING_PIN) return res.status(403).send('Forbidden');

  const DAILY_BRIEFING_URL = process.env.DAILY_BRIEFING_URL;
  if (!DAILY_BRIEFING_URL) {
    return res.status(500).send('DAILY_BRIEFING_URL env var not set');
  }

  // Set processing flag so the briefing page shows the right status
  setBriefingProcessing(true);

  try {
    // Fire the trigger on the Daily-Briefing service — don't await full completion
    axios.get(`${DAILY_BRIEFING_URL}/trigger?pin=${BRIEFING_PIN}`).catch(() => null);
  } catch {}

  res.send(`
    <html>
    <head>
      <meta charset="utf-8">
      <title>Briefing Triggered</title>
      <style>
        body { font-family: 'Montserrat', Arial, sans-serif; background: #F7F8FA; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: #232323; color: #F7F8FA; padding: 40px 48px; border-radius: 14px; border-bottom: 4px solid #FFD70A; text-align: center; max-width: 420px; }
        h1 { font-size: 20px; font-weight: 700; margin: 0 0 10px; }
        p { font-size: 13px; color: #aaa; margin: 0 0 8px; line-height: 1.6; }
        .countdown { font-size: 12px; color: #FFD70A; margin: 0 0 24px; font-weight: 700; }
        a { display: inline-block; background: #FFD70A; color: #232323; text-decoration: none; padding: 10px 24px; border-radius: 8px; font-size: 13px; font-weight: 700; }
      </style>
      <script>
        let secs = 65;
        const briefingUrl = '/briefing?pin=${BRIEFING_PIN}';
        setTimeout(() => { window.location.href = briefingUrl; }, secs * 1000);
        setInterval(() => {
          secs--;
          const el = document.getElementById('countdown');
          if (el) el.textContent = 'Auto-opening briefing in ' + secs + 's…';
          if (secs <= 0) window.location.href = briefingUrl;
        }, 1000);
      </script>
    </head>
    <body>
      <div class="card">
        <h1>🚀 Briefing Running</h1>
        <p>Your briefing is being generated. Takes about 30–60 seconds.</p>
        <p class="countdown" id="countdown">Auto-opening briefing in 65s…</p>
        <a href="/briefing?pin=${BRIEFING_PIN}">Open Now →</a>
      </div>
    </body>
    </html>
  `);
});

// ── PWA manifest ──
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: 'Movement Clinic Briefing',
    short_name: 'Briefing',
    description: 'Daily briefing for Movement Clinic PT',
    start_url: '/briefing?pin=${BRIEFING_PIN}',
    display: 'standalone',
    background_color: '#F7F8FA',
    theme_color: '#232323',
    orientation: 'portrait',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  });
});

// ── PWA icons — simple SVG-based PNG rendered as base64 ──
// Dark square with yellow MC initials — matches brand kit
const PWA_ICON_SVG = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * 0.18}" fill="#232323"/>
  <rect x="0" y="${size * 0.88}" width="${size}" height="${size * 0.12}" rx="0" fill="#FFD70A"/>
  <text x="50%" y="54%" font-family="Arial,sans-serif" font-weight="700" font-size="${size * 0.38}" fill="#F7F8FA" text-anchor="middle" dominant-baseline="middle">MC</text>
</svg>`;

app.get('/icon-192.png', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Content-Disposition', 'inline; filename="icon.svg"');
  res.send(PWA_ICON_SVG(192));
});

app.get('/icon-512.png', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(PWA_ICON_SVG(512));
});

// ── Briefing landing page ──
app.get('/briefing', (req, res) => {
  const { pin } = req.query;
  if (pin !== BRIEFING_PIN) {
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily Briefing</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap');
  body { font-family: 'Montserrat', sans-serif; background: #F7F8FA; color: #232323; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .lock { text-align: center; padding: 40px 24px; }
  .lock h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; color: #232323; letter-spacing: 0.5px; }
  .lock p { font-size: 13px; color: #6b7280; margin-bottom: 28px; font-weight: 500; }
  .lock input { width: 180px; padding: 12px 16px; border-radius: 10px; border: 1px solid #d1d5db; background: #fff; color: #232323; font-size: 18px; text-align: center; letter-spacing: 6px; outline: none; font-family: 'Montserrat', sans-serif; }
  .lock input:focus { border-color: #0065a3; box-shadow: 0 0 0 3px rgba(0,101,163,0.1); }
  .lock button { display: block; margin: 16px auto 0; padding: 11px 32px; background: #232323; color: #F7F8FA; border: none; border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: 'Montserrat', sans-serif; letter-spacing: 0.5px; }
  .lock button:hover { background: #0065a3; }
  .err { color: #ef4444; font-size: 13px; margin-top: 12px; min-height: 18px; }
</style>
</head>
<body>
<div class="lock">
  <h1>Daily Briefing</h1>
  <p>Movement Clinic</p>
  <input type="password" id="pin" placeholder="••••" maxlength="10" autofocus>
  <button onclick="go()">Open</button>
  <div class="err" id="err"></div>
</div>
<script>
  document.getElementById('pin').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  function go() {
    const v = document.getElementById('pin').value.trim();
    if (!v) return;
    window.location.href = '/briefing?pin=' + encodeURIComponent(v);
  }
</script>
</body>
</html>`);
  }

  // Load briefing data
  let data = null;
  try {
    if (fs.existsSync(BRIEFING_FILE)) {
      data = JSON.parse(fs.readFileSync(BRIEFING_FILE, 'utf8'));
    }
  } catch (e) { /* fall through to no-data state */ }

  const { isProcessing: briefingIsProcessing, startedAt: briefingProcessingStartedAt } = getBriefingProcessingState();
  const a = data?.analysis || {};
  const draftTexts = data?.draftTexts || {};
  const savedAt = data?.savedAt ? new Date(data.savedAt) : null;
  const dateStr = savedAt
    ? savedAt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : 'No briefing loaded';
  const timeStr = savedAt
    ? savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    : '';

  const priorityActions   = a.priority_actions_today || [];
  const emailsNeedReply   = a.emails_needing_response || [];
  const upcomingTasks     = a.upcoming_deadlines || [];
  const overdueItems      = a.overdue_items || [];
  const delegateItems     = a.delegate_to_admin || [];
  const calendarEvents    = a.calendar_events || [];
  const noDueDateItems    = a.no_due_date_tasks || [];
  const staleItems        = a.stale_tasks || a.stale_items || [];
  const overallSummary    = a.overall_summary || '';

  // ── HTML helpers ──────────────────────────────────────────────────────────

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function taskBadge(item) {
    if (item.type === 'email') return '<span class="badge badge-email">Email</span>';
    return '<span class="badge badge-task">Task</span>';
  }

  function urgencyClass(item) {
    const why = (item.why || '').toLowerCase();
    if (why.includes('overdue') || why.includes('today')) return 'urgency-high';
    if (why.includes('tomorrow') || why.includes('this week')) return 'urgency-med';
    return 'urgency-low';
  }

  function mailtoLink(to, subject, body) {
    return 'mailto:' + encodeURIComponent(to)
      + '?subject=' + encodeURIComponent(subject)
      + '&body=' + encodeURIComponent(body);
  }

  function draftHtml(item) {
    const d = draftTexts[item.message_id];
    if (!d) return '';
    if (d.type === 'single') {
      const href = mailtoLink(d.to || '', d.subject || '', d.body || '');
      return `<a class="btn btn-draft" href="${esc(href)}">✏️ Reply Draft</a>`;
    }
    if (d.type === 'ambiguous') {
      const hrefYes = mailtoLink(d.to || '', d.subject || '', d.bodyYes || '');
      const hrefNo  = mailtoLink(d.to || '', d.subject || '', d.bodyNo  || '');
      return `<a class="btn btn-draft" href="${esc(hrefYes)}">✏️ ${esc(d.labelYes || 'Yes')}</a>
              <a class="btn btn-draft-alt" href="${esc(hrefNo)}">✏️ ${esc(d.labelNo || 'Decline')}</a>`;
    }
    return '';
  }

  function markDoneBtn(notionId, title) {
    if (!notionId) return '';
    return `<button class="btn btn-done" onclick="markDone(this,'${esc(notionId)}','${esc(title).replace(/'/g,"\\'")}')">✓ Mark Done</button>`;
  }

  function makePushPayload(item) {
    return {
      title: item.title || '',
      notionUrl: item.url || '',
      contactName: item.contact_name || '',
      contactPhone: item.contact_phone || '',
      suggestedNotes: item.suggested_notes || item.reason || '',
    };
  }

  function pushToAdminBtn(item) {
    const encoded = encodeURIComponent(JSON.stringify(makePushPayload(item)));
    return `<button class="btn btn-admin" onclick="openModal(this,'admin',JSON.parse(decodeURIComponent('${encoded}')))">→ Admin</button>`;
  }

  function pushToDirectorBtn(item) {
    const encoded = encodeURIComponent(JSON.stringify(makePushPayload(item)));
    return `<button class="btn btn-director" onclick="openModal(this,'director',JSON.parse(decodeURIComponent('${encoded}')))">→ Director</button>`;
  }

  function renderItems(items, emptyMsg) {
    if (!items || items.length === 0) {
      return `<p class="empty">${emptyMsg}</p>`;
    }
    return items.map(item => `
      <div class="card ${item.notion_id ? urgencyClass(item) : ''}" id="card-${esc(item.notion_id || item.message_id || Math.random())}">
        <div class="card-header">
          <div class="card-left">
            ${taskBadge(item)}
            <a class="card-title" href="${esc(item.url)}" target="_blank">${esc(item.title)}</a>
          </div>
          <div class="card-actions">
            ${markDoneBtn(item.notion_id, item.title)}
            ${draftHtml(item)}
            ${pushToAdminBtn(item)}
            ${pushToDirectorBtn(item)}
          </div>
        </div>
        ${item.why ? `<p class="card-why">${esc(item.why)}</p>` : ''}
      </div>`).join('');
  }

  function renderSimpleItems(items, emptyMsg) {
    if (!items || items.length === 0) return `<p class="empty">${emptyMsg}</p>`;
    return items.map(item => `
      <div class="card" id="card-${esc(item.notion_id || item.message_id || Math.random())}">
        <div class="card-header">
          <div class="card-left">
            ${taskBadge(item)}
            <a class="card-title" href="${esc(item.url)}" target="_blank">${esc(item.title || item.deadline || 'Item')}</a>
          </div>
          <div class="card-actions">
            ${markDoneBtn(item.notion_id, item.title)}
            ${pushToAdminBtn(item)}
            ${pushToDirectorBtn(item)}
          </div>
        </div>
        ${item.due_date ? `<p class="card-why">📅 Due: ${esc(item.due_date)}</p>` : ''}
        ${item.when ? `<p class="card-why">📅 ${esc(item.when)}</p>` : ''}
        ${item.action ? `<p class="card-why">→ ${esc(item.action)}</p>` : ''}
        ${item.suggested_action ? `<p class="card-why">→ ${esc(item.suggested_action)}</p>` : ''}
        ${item.why ? `<p class="card-why">${esc(item.why)}</p>` : ''}
        ${item.reason ? `<p class="card-why">🕰 ${esc(item.reason)}</p>` : ''}
        ${item.recommendation ? `<p class="card-why">💡 ${esc(item.recommendation)}</p>` : ''}
        ${item.recurring_flag ? `<p class="card-why">${esc(item.recurring_flag)}</p>` : ''}
      </div>`).join('');
  }

  function renderDelegateItems(items, emptyMsg) {
    if (!items || items.length === 0) return `<p class="empty">${emptyMsg}</p>`;
    return items.map(item => `
      <div class="card" id="card-${esc(item.notion_id || item.message_id || Math.random())}">
        <div class="card-header">
          <div class="card-left">
            ${taskBadge(item)}
            <a class="card-title" href="${esc(item.url)}" target="_blank">${esc(item.title || 'Item')}</a>
          </div>
        </div>
        ${item.reason ? `<p class="card-why">🕰 ${esc(item.reason)}</p>` : ''}
        ${item.suggested_notes ? `<p class="card-why">💬 ${esc(item.suggested_notes)}</p>` : ''}
        ${item.contact_name ? `<p class="card-why">👤 ${esc(item.contact_name)}</p>` : ''}
        <div class="card-actions" style="margin-top:10px;">
          ${markDoneBtn(item.notion_id, item.title)}
          ${pushToAdminBtn(item)}
          ${pushToDirectorBtn(item)}
        </div>
      </div>`).join('');
  }

  function renderEmailItems(items, emptyMsg) {
    if (!items || items.length === 0) return `<p class="empty">${emptyMsg}</p>`;
    return items.map(item => `
      <div class="card" id="card-${esc(item.message_id || Math.random())}">
        <div class="card-header">
          <div class="card-left">
            <span class="badge badge-email">Email</span>
            <span class="card-title">${esc(item.subject || item.title || '(no subject)')}</span>
          </div>
        </div>
        ${item.from ? `<p class="card-why">From: ${esc(item.from)}</p>` : ''}
        ${item.summary ? `<p class="card-why">${esc(item.summary)}</p>` : ''}
        ${item.why ? `<p class="card-why">${esc(item.why)}</p>` : ''}
        ${item.recurring_flag ? `<p class="card-why">${esc(item.recurring_flag)}</p>` : ''}
        <div class="card-actions" style="margin-top:10px;flex-wrap:wrap;gap:6px;">
          <a class="btn btn-draft" href="${esc(item.url || '#')}" target="_blank">📬 View Email</a>
          ${draftHtml(item)}
          ${pushToAdminBtn(item)}
          ${pushToDirectorBtn(item)}
        </div>
      </div>`).join('');
  }

  function renderCalendarEvents(items, emptyMsg) {
    if (!items || items.length === 0) return `<p class="empty">${emptyMsg}</p>`;
    return items.map(item => `
      <div class="card">
        <div class="card-header">
          <div class="card-left">
            <span class="badge badge-event">Event</span>
            <a class="card-title" href="${esc(item.url || '#')}" target="_blank">${esc(item.title || item.name || 'Event')}</a>
          </div>
        </div>
        ${item.date || item.eventDate ? `<p class="card-why">📅 ${esc(item.date || item.eventDate)}</p>` : ''}
        ${item.description ? `<p class="card-why">${esc(item.description)}</p>` : ''}
      </div>`).join('');
  }

  function section(id, title, count, content, startOpen = true) {
    const openAttr = startOpen ? 'open' : '';
    const countBadge = count > 0 ? `<span class="section-count">${count}</span>` : '';
    return `
    <details class="section" ${openAttr} id="section-${id}">
      <summary class="section-summary">
        <span class="section-title">${title}${countBadge}</span>
        <span class="chevron">▾</span>
      </summary>
      <div class="section-body">${content}</div>
    </details>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Daily Briefing — ${esc(dateStr)}</title>
<link rel="manifest" href="/manifest.json">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Briefing">
<meta name="theme-color" content="#232323">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, sans-serif;
    background: #F7F8FA;
    color: #232323;
    min-height: 100vh;
    padding: 0 0 env(safe-area-inset-bottom, 60px);
    padding-bottom: max(60px, env(safe-area-inset-bottom));
  }

  /* ── Top bar ── */
  .topbar {
    background: #232323;
    border-bottom: 3px solid #FFD70A;
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .topbar-left h1 { font-size: 17px; font-weight: 700; color: #F7F8FA; letter-spacing: 0.5px; }
  .topbar-left p  { font-size: 11px; color: #aaa; margin-top: 3px; font-weight: 500; }
  .topbar-right   { display: flex; gap: 10px; align-items: center; }
  .expand-all, .collapse-all {
    font-size: 11px; font-weight: 600; color: #aaa; background: none;
    border: 1px solid #555; padding: 5px 12px; border-radius: 6px; cursor: pointer;
    font-family: 'Montserrat', sans-serif; letter-spacing: 0.3px;
  }
  .expand-all:hover, .collapse-all:hover { color: #FFD70A; border-color: #FFD70A; }

  /* ── Summary banner ── */
  .summary-banner {
    background: #fff;
    border-left: 4px solid #0065a3;
    margin: 20px 16px 0;
    padding: 14px 18px;
    border-radius: 0 8px 8px 0;
    font-size: 13px;
    line-height: 1.7;
    color: #555;
    font-weight: 500;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }

  /* ── Sections ── */
  .section {
    margin: 14px 16px 0;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  }

  .section-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 13px 18px;
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  .section-summary::-webkit-details-marker { display: none; }
  .section-summary:hover { background: #f9fafb; }

  .section-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #6b7280;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .section-count {
    background: #0065a3;
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 20px;
    letter-spacing: 0;
    text-transform: none;
  }

  .chevron {
    color: #9ca3af;
    font-size: 14px;
    transition: transform 0.2s;
  }
  details[open] .chevron { transform: rotate(180deg); }

  .section-body { padding: 4px 12px 12px; }

  /* ── Cards ── */
  .card {
    background: #F7F8FA;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    padding: 13px 14px;
    margin-top: 8px;
    border-left-width: 3px;
    border-left-color: #e5e7eb;
  }
  .urgency-high { border-left-color: #ef4444; }
  .urgency-med  { border-left-color: #FFD70A; }
  .urgency-low  { border-left-color: #e5e7eb; }

  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .card-left {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }
  .card-title {
    color: #232323;
    text-decoration: none;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.4;
    word-break: break-word;
    overflow-wrap: anywhere;
    flex: 1;
    min-width: 0;
    display: block;
  }
  .card-title:hover { color: #0065a3; text-decoration: underline; }

  .card-why {
    font-size: 11px;
    color: #6b7280;
    margin-top: 6px;
    line-height: 1.5;
    font-weight: 500;
  }

  .card-actions {
    display: flex;
    gap: 7px;
    flex-shrink: 0;
    flex-wrap: wrap;
    align-items: flex-start;
    width: 100%;
    margin-top: 8px;
  }

  @media (min-width: 520px) {
    .card-actions {
      width: auto;
      margin-top: 0;
    }
    .card-header {
      flex-wrap: nowrap;
    }
  }

  /* ── Badges ── */
  .badge {
    font-size: 9px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 4px;
    white-space: nowrap;
    flex-shrink: 0;
    margin-top: 2px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
  }
  .badge-task  { background: #0065a3; color: #fff; }
  .badge-email { background: #232323; color: #FFD70A; }
  .badge-event { background: #FFD70A; color: #232323; }

  /* ── Buttons ── */
  .btn {
    font-size: 11px;
    font-weight: 700;
    padding: 5px 11px;
    border-radius: 7px;
    border: none;
    cursor: pointer;
    white-space: nowrap;
    text-decoration: none;
    display: inline-block;
    line-height: 1.4;
    font-family: 'Montserrat', sans-serif;
    letter-spacing: 0.3px;
  }
  .btn-done {
    background: #dcfce7;
    color: #166534;
    border: 1px solid #bbf7d0;
  }
  .btn-done:hover { background: #bbf7d0; }
  .btn-done.done  { background: #f0fdf4; color: #4ade80; cursor: default; opacity: 0.7; }
  .btn-done.loading { opacity: 0.4; cursor: wait; }

  .btn-draft {
    background: #e0f0fa;
    color: #0065a3;
    border: 1px solid #bfdbee;
  }
  .btn-draft:hover { background: #bfdbee; }

  .btn-draft-alt {
    background: #f3f4f6;
    color: #6b7280;
    border: 1px solid #d1d5db;
  }
  .btn-draft-alt:hover { background: #e5e7eb; }

  /* ── Empty state ── */
  .empty {
    font-size: 12px;
    color: #9ca3af;
    padding: 12px 4px;
    font-style: italic;
    font-weight: 500;
  }

  /* ── Push to Admin button ── */
  .btn-admin {
    background: #FFF8E1;
    color: #92400e;
    border: 1px solid #FFD70A;
  }
  .btn-admin:hover { background: #FFD70A; color: #232323; }
  .btn-admin.loading { opacity: 0.4; cursor: wait; }
  .btn-admin.sent { background: #dcfce7; color: #166534; border-color: #bbf7d0; cursor: default; }

  .btn-director {
    background: #f3f4f6;
    color: #4b5563;
    border: 1px solid #d1d5db;
  }
  .btn-director:hover { background: #e5e7eb; color: #232323; border-color: #9ca3af; }
  .btn-director.loading { opacity: 0.4; cursor: wait; }
  .btn-director.sent { background: #dcfce7; color: #166534; border-color: #bbf7d0; cursor: default; }

  /* ── Modal ── */
  .modal-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.4);
    z-index: 200;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .modal-overlay.active { display: flex; }
  .modal {
    background: #fff;
    border-radius: 14px;
    padding: 24px;
    width: 100%;
    max-width: 480px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.15);
  }
  .modal h3 { font-size: 15px; font-weight: 700; color: #232323; margin: 0 0 4px; }
  .modal .modal-subtitle { font-size: 12px; color: #6b7280; margin: 0 0 16px; font-weight: 500; }
  .modal textarea {
    width: 100%;
    min-height: 100px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
    font-family: 'Montserrat', sans-serif;
    color: #232323;
    resize: vertical;
    outline: none;
    line-height: 1.5;
  }
  .modal textarea:focus { border-color: #0065a3; box-shadow: 0 0 0 3px rgba(0,101,163,0.1); }
  .modal-actions { display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end; }
  .modal-cancel { background: #f3f4f6; color: #6b7280; border: 1px solid #d1d5db; }
  .modal-cancel:hover { background: #e5e7eb; }
  .modal-confirm { background: #232323; color: #F7F8FA; border: none; }
  .modal-confirm:hover { background: #0065a3; }
  .modal-status { font-size: 12px; margin-top: 10px; min-height: 16px; color: #6b7280; font-weight: 500; }

  /* ── No data state ── */
  .no-data {
    text-align: center;
    padding: 80px 24px;
    color: #6b7280;
  }
  .no-data h2 { font-size: 18px; margin-bottom: 8px; color: #232323; font-weight: 700; }
  .no-data p  { font-size: 13px; font-weight: 500; }
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-left">
    <h1>Daily Briefing</h1>
    <p>${esc(dateStr)}${timeStr ? ' · Generated ' + esc(timeStr) : ''}</p>
  </div>
  <div class="topbar-right">
    <button class="expand-all"   onclick="toggleAll(true)">Expand all</button>
    <button class="collapse-all" onclick="toggleAll(false)">Collapse all</button>
  </div>
</div>

${briefingIsProcessing ? `
<div class="no-data">
  <h2 style="color:#0065a3;">⏳ Processing your briefing…</h2>
  <p>Your daily briefing is being generated right now. This takes about 30–60 seconds.</p>
  <p style="margin-top:8px;font-size:11px;color:#9ca3af;">Started at ${esc(briefingProcessingStartedAt || '')} · This page will update when ready.</p>
  <button onclick="window.location.reload()" style="margin-top:20px;background:#232323;color:#F7F8FA;border:none;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:'Montserrat',sans-serif;">Refresh Page</button>
</div>` : !data ? `<div class="no-data"><h2>No briefing available</h2><p>The daily briefing hasn't run yet, or the server was restarted.</p></div>` : `

${overallSummary ? `<div class="summary-banner">${esc(overallSummary)}</div>` : ''}

${section('priority', '🔴 Priority Actions Today', priorityActions.length,
    renderItems(priorityActions, 'No priority actions — you\'re clear.'), true)}

${section('overdue', '⚠️ Overdue', overdueItems.length,
    renderSimpleItems(overdueItems, 'Nothing overdue.'), true)}

${section('emails', '📧 Emails Needing Response', emailsNeedReply.length,
    renderEmailItems(emailsNeedReply, 'No emails flagged for response.'), true)}

${section('delegate', '👤 Delegate to Admin', delegateItems.length,
    renderDelegateItems(delegateItems, 'Nothing to delegate.'), false)}

${section('calendar', '📆 Upcoming Events', calendarEvents.length,
    renderCalendarEvents(calendarEvents, 'No upcoming events in the next 21 days.'), false)}

${section('upcoming', '📅 Upcoming Deadlines', upcomingTasks.length,
    renderSimpleItems(upcomingTasks, 'No upcoming task deadlines.'), true)}

${section('noduedate', '📋 All Tasks — No Due Date', noDueDateItems.length,
    renderSimpleItems(noDueDateItems, 'No tasks without a due date.'), true)}

${section('stale', '🕰 Stale Tasks', staleItems.length,
    renderSimpleItems(staleItems, 'Nothing stale.'), false)}

`}

<!-- Push to Admin / Director Modal (shared) -->
<div class="modal-overlay" id="adminModal">
  <div class="modal">
    <h3 id="modalTitle">Push to Admin</h3>
    <p class="modal-subtitle" id="modalSubtitle"></p>
    <textarea id="modalNotes" placeholder="Notes..."></textarea>
    <div class="modal-status" id="modalStatus"></div>
    <div class="modal-actions">
      <button class="btn modal-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn modal-confirm" onclick="confirmPush()">Send</button>
    </div>
  </div>
</div>

<script>
  const PIN = '${esc(BRIEFING_PIN)}';
  // _modalData tracks the active modal state: the data payload, the originating button, and the target route
  let _modalData = null;

  function toggleAll(open) {
    document.querySelectorAll('details.section').forEach(d => d.open = open);
  }

  // Track done notion IDs in memory so all instances of the same task get greyed out
  const _doneIds = new Set();

  async function markDone(btn, notionId, title) {
    if (btn.classList.contains('done') || btn.classList.contains('loading')) return;
    btn.classList.add('loading');
    btn.textContent = '…';

    try {
      const res = await fetch('/mark-done', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-briefing-pin': PIN },
        body: JSON.stringify({ notionId }),
      });
      if (!res.ok) throw new Error('Server error');

      // Mark ALL cards with this notionId across every section
      _doneIds.add(notionId);
      document.querySelectorAll('.card').forEach(card => {
        if (card.id === 'card-' + notionId) {
          applyDoneStyle(card);
        }
      });
    } catch (err) {
      btn.classList.remove('loading');
      btn.textContent = '✓ Mark Done';
      alert('Failed to mark done: ' + err.message);
    }
  }

  function applyDoneStyle(card) {
    // Grey out the card and strike through the title — don't remove it
    card.style.opacity = '0.45';
    card.style.pointerEvents = 'none';
    const title = card.querySelector('.card-title');
    if (title) title.style.textDecoration = 'line-through';
    const btn = card.querySelector('.btn-done');
    if (btn) {
      btn.textContent = '✓ Done';
      btn.classList.remove('loading');
      btn.classList.add('done');
    }
  }

  // target: 'admin' or 'director'
  function openModal(btn, target, data) {
    // Always fully reset before opening — prevents stale state from prior interactions
    _modalData = { ...data, btn, target };

    const isDirector = target === 'director';
    const confirmBtn = document.querySelector('.modal-confirm');

    document.getElementById('modalTitle').textContent = isDirector
      ? 'Push to Clinic Director'
      : 'Push to Admin';
    document.getElementById('modalSubtitle').textContent = data.contactName
      ? 'Contact: ' + data.contactName
      : 'No contact associated';
    document.getElementById('modalNotes').value = data.suggestedNotes || '';
    document.getElementById('modalStatus').textContent = '';

    // Reset confirm button in case it was left in a bad state from a prior send
    confirmBtn.textContent = isDirector ? 'Send to Director' : 'Send to Admin';
    confirmBtn.disabled = false;

    document.getElementById('adminModal').classList.add('active');
    setTimeout(() => document.getElementById('modalNotes').focus(), 50);
  }

  function closeModal() {
    document.getElementById('adminModal').classList.remove('active');
    // Reset confirm button state so the next open starts clean
    const confirmBtn = document.querySelector('.modal-confirm');
    if (confirmBtn) {
      confirmBtn.textContent = 'Send';
      confirmBtn.disabled = false;
    }
    // Null out — not just empty object — so stale reads throw instead of silently proceeding
    _modalData = null;
  }

  document.getElementById('adminModal').addEventListener('click', e => {
    if (e.target === document.getElementById('adminModal')) closeModal();
  });

  async function confirmPush() {
    if (!_modalData) return; // Guard against stale calls
    const notes = document.getElementById('modalNotes').value.trim();
    const status = document.getElementById('modalStatus');
    const confirmBtn = document.querySelector('.modal-confirm');
    const isDirector = _modalData.target === 'director';
    const endpoint = isDirector ? '/push-to-director' : '/push-to-admin';

    confirmBtn.textContent = 'Sending…';
    confirmBtn.disabled = true;
    status.textContent = '';

    // Snapshot the data we need before closeModal() clears _modalData
    const { title, notionUrl, contactName, contactPhone, btn: originBtn } = _modalData;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-briefing-pin': PIN },
        body: JSON.stringify({ title, notes, notionUrl, contactName: contactName || null, contactPhone: contactPhone || null }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Server error ' + res.status);
      }

      // Mark the originating button as sent before closing
      if (originBtn) {
        originBtn.textContent = '✓ Sent';
        originBtn.classList.add('sent');
        originBtn.disabled = true;
      }
      closeModal();
    } catch (err) {
      // On failure: restore button so user can retry, show error inline
      status.textContent = '⚠ ' + err.message;
      confirmBtn.textContent = isDirector ? 'Send to Director' : 'Send to Admin';
      confirmBtn.disabled = false;
      // Do NOT clear _modalData — user may want to retry
    }
  }
</script>
</body>
</html>`;

  res.send(html);
});

// ============================================================
// POST-EVAL FORM
// ============================================================

const EVAL_CUSTOMER_PIPELINE_ID = '0UnRjFIzcaUf35zXVXmT';
const EVAL_CUSTOMER_STAGES = {
  EVALUATION_SCHEDULED: '5e8c01e5-7ffb-4308-b1a6-91602ad012da',
  EVALUATION_HELD: '5d1f6b5e-93fa-480f-8d41-4fe4817c2e43',
  PENDING_VISIT: '6ff7cfd7-a308-4298-89ec-6855d7f383ff',
  PENDING_CALL: '11bfcc99-c1c1-4936-8a04-73386796e1ea',
  PENDING_NO_FIRM_TIME: 'eb8828cb-98c5-4cdd-8510-56a174540a4e',
  PACKAGE_PURCHASED: 'cc3f6b52-846a-4bcc-9cd5-646ca5712ea1',
  NOT_GOOD_TIME: 'f7ce8c60-7695-4da4-8c1b-5a030967647a',
  CLOSED_LOST: '5b13fe92-130a-4cd6-b9a5-eca5f8ff5729'
};

// LTV field key from GHL
const GHL_LTV_FIELD = 'contact.lifetime_value_ltv';
const LTV_CUSTOMER_THRESHOLD = 500;

const CONTINUITY_PIPELINE_ID = 'UwFUs0w3nmj6k0f1EEXm';
const CONTINUITY_PURCHASED_STAGE_ID = '63d7e07f-e3cc-4931-9d2e-0f67028bd2be';

const GHL_SHEET_WEBHOOK = 'https://services.leadconnectorhq.com/hooks/6oqyEZ6nlqPw4cDsaKzi/webhook-trigger/013d41b5-f370-4422-9353-3f7d90b21890';
const REHAB_ESSENTIALS_WEBHOOK = 'https://services.leadconnectorhq.com/hooks/6oqyEZ6nlqPw4cDsaKzi/webhook-trigger/e2b1cd03-f854-4c7b-a156-44b854ba13bf';
const EVAL_TEAM_WEBHOOK = 'https://services.leadconnectorhq.com/hooks/6oqyEZ6nlqPw4cDsaKzi/webhook-trigger/iXwd91Z53dXc3hGrbDjv';
const EVAL_JORDAN_WEBHOOK = 'https://services.leadconnectorhq.com/hooks/6oqyEZ6nlqPw4cDsaKzi/webhook-trigger/aeecdec8-5dbf-4bfe-9bd4-aa33f5962589';

const PT_CALENDARS = {
  'John Gan': { calendarId: 'APgRoYlz3Tba9ABff2iR', ghlUserId: 'Q9S0gVhPbAlXN7zPMgWo' },
  'TJ Aquino': { calendarId: 'E3UHHXgE7ZETRFeftWOt', ghlUserId: 'CqYh2l1GM4kIxfKtAXEZ' },
  'Chris Bostwick': { calendarId: 'UIOXtZg8Ucfk2S8N8Rj1', ghlUserId: 'awm68XlHfnAH8MVMIP4O' },
  'Jordan McCormack': { calendarId: 'j1GTYCTZU7vzKnlkLl8N', ghlUserId: 'sqeaYakcEi10FMK1OZwD' }
};

const OBJECTION_CATEGORIES = [
  'Too Expensive',
  'Wants to Explore In-Network Care',
  'Time Commitment',
  'Not the Right Time',
  'Needs to Talk to Spouse',
  'Needs to Think About It',
  'Business Hours Don\'t Work',
  'Other'
];

const STAGE1_TEXT = (firstName) => `Hey ${firstName}! We are so excited to work along side you in your rehab and performance journey. A couple of things we wanted to clarify moving forward:

1) Are you planning to use superbills for reimbursement either through a PPO insurance plan or HSA/FSA account?

2) Is there a preferred physician that you would like us to send updates to during your time with us? Typically this is the physician that referred you or if you've been working with an orthopedic physician that recommended PT then looping them in is helpful as well.

When you get a chance let us know the details here!`;

const STAGE2_TEXT = (firstName) => `Hey ${firstName}! We are so excited to continue working with you. We are all about playing the long game and are amped to help you reach your long-term, bucket list goals! A couple of quick things, since you are continuing your time with us

1) Are you planning to use superbills for reimbursement either through a PPO insurance plan or HSA/FSA account? Has anything changed on this since initially starting to work with us?

2) Is there a preferred physician that you would like us to send updates to during your time with us? Typically this is the physician that referred you or if you've been working with an orthopedic physician that recommended PT then looping them in is helpful as well. Same thing, let us know if anything has changed here as well.

When you get a chance let us know the details here!`;

const EVAL_CLAUDE_PROMPT = `You are a clinical and sales analyst for Movement Clinic Physical Therapy, a cash-based physical therapy clinic in Pasadena, CA. Analyze this post-evaluation session transcript and extract structured information and observations.

The PT has already indicated the primary outcome (Converted, Pending, or Lost). Your job is to extract specifics and provide coaching analysis.

EXTRACT THE FOLLOWING:

1. PLAN OF CARE PT: Look for any mention of who will be handling ongoing care. Return null if not mentioned (system defaults to evaluating PT).

2. PAYMENT METHOD: Look for any mention of how the patient paid or will pay — Zelle, card on PTEverywhere, cash, check, installments, etc. If unclear return "Unclear from transcript".

3. IF PENDING — determine sub-type:
   - PENDING_VISIT: A follow-up in-person visit explicitly booked with a specific date
   - PENDING_CALL: A follow-up phone call has been committed to, even without an exact time. Includes 'I will call you by end of day tomorrow', 'expect my call by Friday', 'I will reach out tomorrow'. Calculate the date from context
   - PENDING_VAGUE: No firm date/time established, patient said they will think about it, reach out later, or no next step was set

4. IF PENDING_VISIT — extract: follow_up_visit_date (format: YYYY-MM-DD or null)

5. IF PENDING_CALL — extract:
   - follow_up_call_date (format: YYYY-MM-DD or null)
   - follow_up_call_time (format: HH:MM AM/PM or null)

6. IF LOST — extract:
   - objection_category: must be exactly one of: "Too Expensive", "Wants to Explore In-Network Care", "Time Commitment", "Not the Right Time", "Needs to Talk to Spouse", "Needs to Think About It", "Business Hours Don't Work", "Other"
   - objection_detail: 1-2 sentence concise summary of the specific reason given

7. next_steps: 1-2 sentence summary of what was agreed upon as the next touch point

8. evaluation_summary: 2-3 sentence summary of the evaluation — what the patient came in for, what was assessed, and what the PT recommended. Clinical but concise.

9. physician_name: name of any physician mentioned, otherwise null

10. physician_office: office or practice of physician if mentioned, otherwise null

11. COACHING NOTES: Provide specific, actionable observations about the PT's sales and communication performance. Focus on:
    - How objections were handled (or not handled)
    - Whether value was clearly communicated before price was discussed
    - Whether the PT established clear next steps ("book a meeting from a meeting")
    - Quality of rapport building and active listening
    - Any missed opportunities to address patient concerns
    - What was done well
    Be specific — reference actual moments from the transcript. 2-4 bullet points. If the conversion was clean with no issues, note what the PT did well. Format as plain text with each point on a new line starting with a dash.

12. RED FLAGS: Note anything that warrants Jordan's immediate attention:
    - Patient expressed frustration, upset, or left abruptly
    - Patient mentioned legal situations (workers comp, litigation, attorney)
    - Patient showed signs of distrust or skepticism toward the clinic
    - Patient comparing to other clinics in a concerning way
    - Any safety or clinical concerns mentioned
    - PT made commitments or promises that seem unusual
    If no red flags return "None identified."

RETURN ONLY valid JSON with no preamble or markdown:
{
  "plan_of_care_pt": null,
  "payment_method": "Unclear from transcript",
  "pending_subtype": null,
  "follow_up_visit_date": null,
  "follow_up_call_date": null,
  "follow_up_call_time": null,
  "objection_category": null,
  "objection_detail": null,
  "next_steps": null,
  "evaluation_summary": null,
  "physician_name": null,
  "physician_office": null,
  "coaching_notes": null,
  "red_flags": "None identified."
}`;

async function sendQuoSMS(toPhone, message) {
  try {
    await axios.post(
      'https://api.openphone.com/v1/messages',
      {
        to: [toPhone],
        from: CLINIC_PHONE_NUMBERS[0],
        content: message
      },
      { headers: { 'Authorization': QUO_API_KEY, 'Content-Type': 'application/json' } }
    );
    console.log(`SMS sent to ${toPhone}`);
  } catch (err) {
    console.error('Failed to send SMS:', err.response?.data || err.message);
  }
}

async function createGHLCalendarAppointment(contactId, calendarId, ptUserId, patientName, ptFirstName, dateStr, timeStr) {
  try {
    // Parse date and time into ISO format
    const dateTimeStr = `${dateStr} ${timeStr}`;
    const appointmentDate = new Date(dateTimeStr);
    const endDate = new Date(appointmentDate.getTime() + 30 * 60000); // 30 min default

    await axios.post(
      'https://services.leadconnectorhq.com/calendars/events',
      {
        calendarId,
        locationId: GHL_LOCATION_ID,
        contactId,
        title: `Follow Up Call - ${patientName.split(' ')[0]} x ${ptFirstName}`,
        appointmentStatus: 'confirmed',
        assignedUserId: ptUserId,
        startTime: appointmentDate.toISOString(),
        endTime: endDate.toISOString()
      },
      { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' } }
    );
    console.log('GHL calendar appointment created');
  } catch (err) {
    console.error('Failed to create calendar appointment:', err.response?.data || err.message);
  }
}

async function updateOpportunityCustomFields(opportunityId, objectionCategory, objectionDetail) {
  try {
    await axios.put(
      `https://services.leadconnectorhq.com/opportunities/${opportunityId}`,
      {
        customFields: [
          { key: 'opportunity.objection_category', field_value: objectionCategory },
          { key: 'opportunity.objection_detail', field_value: objectionDetail }
        ]
      },
      { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' } }
    );
    console.log('Custom fields updated');
  } catch (err) {
    console.error('Failed to update custom fields:', err.response?.data || err.message);
  }
}

async function addGHLTag(contactId, tag) {
  try {
    await axios.post(
      `https://services.leadconnectorhq.com/contacts/${contactId}/tags`,
      { tags: [tag] },
      { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Failed to add tag:', err.response?.data || err.message);
  }
}

async function assignOpportunityToUser(opportunityId, userId) {
  try {
    await axios.put(
      `https://services.leadconnectorhq.com/opportunities/${opportunityId}`,
      { assignedTo: userId },
      { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' } }
    );
    console.log(`Opportunity assigned to user ${userId}`);
  } catch (err) {
    console.error('Failed to assign opportunity:', err.response?.data || err.message);
  }
}

async function getContactLTV(contactId) {
  try {
    const response = await axios.get(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
    );
    const contact = response.data.contact;
    const customFields = contact.customFields || [];
    const ltvField = customFields.find(f => f.key === GHL_LTV_FIELD || f.id === 'lifetime_value_ltv');
    if (ltvField) return parseFloat(ltvField.value) || 0;
    // Also check native monetaryValue field
    if (contact.monetaryValue) return parseFloat(contact.monetaryValue) || 0;
    return 0;
  } catch (err) {
    console.error('Failed to get contact LTV:', err.message);
    return 0;
  }
}

async function checkExistingCustomer(contactId, allOpportunities) {
  // Signal 1: Has opportunity at Package Purchased in Customer Pipeline
  const hasPackagePurchased = allOpportunities.some(
    o => o.pipelineId === EVAL_CUSTOMER_PIPELINE_ID &&
    o.pipelineStageId === EVAL_CUSTOMER_STAGES.PACKAGE_PURCHASED
  );
  if (hasPackagePurchased) return { isCustomer: true, reason: 'package_purchased', opp: allOpportunities.find(o => o.pipelineId === EVAL_CUSTOMER_PIPELINE_ID && o.pipelineStageId === EVAL_CUSTOMER_STAGES.PACKAGE_PURCHASED) };

  // Signal 2: Has any opportunity in Continuity Pipeline
  const continuityOpp = allOpportunities.find(o => o.pipelineId === CONTINUITY_PIPELINE_ID);
  if (continuityOpp) return { isCustomer: true, reason: 'continuity', opp: continuityOpp };

  // Signal 3: Lifetime value > $500
  const ltv = await getContactLTV(contactId);
  if (ltv > LTV_CUSTOMER_THRESHOLD) return { isCustomer: true, reason: 'ltv', opp: null, ltv };

  return { isCustomer: false };
}

async function analyzeEvalWithClaude(transcript, outcome) {
  const userMessage = `${EVAL_CLAUDE_PROMPT}\n\nOUTCOME SELECTED BY PT: ${outcome}\n\nTRANSCRIPT:\n${transcript}`;
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: userMessage }] },
    { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
  );
  const text = response.data.content[0].text;
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// Serve the post-eval form HTML
app.get('/post-eval', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Post-Eval Form — Movement Clinic</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  
  :root {
    --ink: #1a1a1a;
    --muted: #6b7280;
    --border: #e5e7eb;
    --surface: #f9fafb;
    --accent: #0f766e;
    --accent-light: #ccfbf1;
    --danger: #dc2626;
    --warn: #f59e0b;
    --radius: 10px;
  }

  body {
    font-family: 'DM Sans', sans-serif;
    background: #f0f4f8;
    min-height: 100vh;
    padding: 40px 16px 80px;
    color: var(--ink);
  }

  .shell {
    max-width: 680px;
    margin: 0 auto;
  }

  .header {
    text-align: center;
    margin-bottom: 40px;
  }

  .header h1 {
    font-family: 'DM Serif Display', serif;
    font-size: 32px;
    font-weight: 400;
    letter-spacing: -0.5px;
    color: var(--ink);
  }

  .header p {
    margin-top: 8px;
    font-size: 14px;
    color: var(--muted);
  }

  .card {
    background: #fff;
    border-radius: 16px;
    border: 1px solid var(--border);
    padding: 32px;
    margin-bottom: 16px;
  }

  .card-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--muted);
    margin-bottom: 20px;
  }

  .field { margin-bottom: 20px; }
  .field:last-child { margin-bottom: 0; }

  label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 6px;
    color: var(--ink);
  }

  input[type="text"],
  input[type="email"],
  input[type="tel"],
  textarea {
    width: 100%;
    padding: 10px 14px;
    border: 1.5px solid var(--border);
    border-radius: var(--radius);
    font-family: 'DM Sans', sans-serif;
    font-size: 14px;
    color: var(--ink);
    background: #fff;
    transition: border-color 0.15s;
    outline: none;
  }

  input:focus, textarea:focus {
    border-color: var(--accent);
  }

  textarea {
    resize: vertical;
    min-height: 200px;
    line-height: 1.6;
  }

  .row-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .radio-group {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .radio-pill input[type="radio"] { display: none; }

  .radio-pill label {
    display: inline-flex;
    align-items: center;
    padding: 8px 18px;
    border: 1.5px solid var(--border);
    border-radius: 100px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    color: var(--muted);
    background: var(--surface);
    margin: 0;
  }

  .radio-pill input[type="radio"]:checked + label {
    border-color: var(--accent);
    background: var(--accent-light);
    color: var(--accent);
  }

  .outcome-pill input[type="radio"]:checked + label.converted { border-color: #059669; background: #d1fae5; color: #065f46; }
  .outcome-pill input[type="radio"]:checked + label.pending { border-color: var(--warn); background: #fef3c7; color: #92400e; }
  .outcome-pill input[type="radio"]:checked + label.lost { border-color: var(--danger); background: #fee2e2; color: #991b1b; }

  .conditional { display: none; }
  .conditional.visible { display: block; }

  .conditional-card {
    background: var(--surface);
    border: 1.5px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    margin-top: 16px;
  }

  .conditional-card .card-title {
    margin-bottom: 14px;
  }

  .submit-btn {
    width: 100%;
    padding: 16px;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius);
    font-family: 'DM Sans', sans-serif;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s, transform 0.1s;
    margin-top: 8px;
  }

  .submit-btn:hover { opacity: 0.92; }
  .submit-btn:active { transform: scale(0.99); }
  .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .status {
    display: none;
    padding: 16px 20px;
    border-radius: var(--radius);
    font-size: 14px;
    font-weight: 500;
    margin-top: 16px;
  }

  .status.success { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; display: block; }
  .status.error { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; display: block; }
  .status.loading { background: #e0f2fe; color: #0369a1; border: 1px solid #7dd3fc; display: block; }

  @media (max-width: 500px) {
    .row-2 { grid-template-columns: 1fr; }
    .card { padding: 24px 20px; }
  }
</style>
</head>
<body>
<div class="shell">
  <div class="header">
    <h1>Post-Eval Summary</h1>
    <p>Complete immediately after the evaluation session</p>
  </div>

  <form id="evalForm">

    <!-- Patient Info -->
    <div class="card">
      <div class="card-title">Patient Information</div>
      <div class="row-2">
        <div class="field">
          <label>First Name</label>
          <input type="text" name="patient_first_name" required placeholder="First name">
        </div>
        <div class="field">
          <label>Last Name</label>
          <input type="text" name="patient_last_name" required placeholder="Last name">
        </div>
      </div>
      <div class="row-2">
        <div class="field">
          <label>Email</label>
          <input type="email" name="patient_email" required placeholder="patient@email.com">
        </div>
        <div class="field">
          <label>Phone</label>
          <input type="tel" name="patient_phone" required placeholder="+1 (555) 000-0000">
        </div>
      </div>
    </div>

    <!-- PT Selection -->
    <div class="card">
      <div class="card-title">Evaluating Physical Therapist</div>
      <div class="field">
        <div class="radio-group" id="ptGroup">
          ${Object.keys(PT_CALENDARS).map(pt => `
          <div class="radio-pill">
            <input type="radio" name="evaluating_pt" id="pt_${pt.replace(' ', '_')}" value="${pt}" required>
            <label for="pt_${pt.replace(' ', '_')}">${pt}</label>
          </div>`).join('')}
        </div>
      </div>
    </div>

    <!-- Outcome -->
    <div class="card">
      <div class="card-title">Evaluation Outcome</div>
      <div class="field">
        <div class="radio-group" id="outcomeGroup">
          <div class="radio-pill outcome-pill">
            <input type="radio" name="outcome" id="outcome_converted" value="Converted" required>
            <label for="outcome_converted" class="converted">Converted</label>
          </div>
          <div class="radio-pill outcome-pill">
            <input type="radio" name="outcome" id="outcome_pending" value="Pending">
            <label for="outcome_pending" class="pending">Pending</label>
          </div>
          <div class="radio-pill outcome-pill">
            <input type="radio" name="outcome" id="outcome_lost" value="Lost">
            <label for="outcome_lost" class="lost">Lost</label>
          </div>
        </div>

        <!-- Converted sub-options -->
        <div class="conditional" id="convertedOptions">
          <div class="conditional-card">
            <div class="card-title">Purchase Stage</div>
            <div class="radio-group">
              <div class="radio-pill">
                <input type="radio" name="stage" id="stage1" value="Stage 1">
                <label for="stage1">Stage 1 — First Time Purchase</label>
              </div>
              <div class="radio-pill">
                <input type="radio" name="stage" id="stage2" value="Stage 2">
                <label for="stage2">Stage 2 — Returning Patient</label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Additional Options -->
    <div class="card">
      <div class="card-title">Additional Options</div>
      <div class="field">
        <label>Appropriate for Rehab Essentials Emails?</label>
        <div class="radio-group">
          <div class="radio-pill">
            <input type="radio" name="rehab_essentials" id="rehab_yes" value="Yes" required>
            <label for="rehab_yes">Yes</label>
          </div>
          <div class="radio-pill">
            <input type="radio" name="rehab_essentials" id="rehab_no" value="No">
            <label for="rehab_no">No</label>
          </div>
        </div>
      </div>

      <div class="field">
        <label>Send Post-Eval Check-In Text?</label>
        <div class="radio-group">
          <div class="radio-pill">
            <input type="radio" name="send_checkin" id="checkin_yes" value="Yes" required>
            <label for="checkin_yes">Yes</label>
          </div>
          <div class="radio-pill">
            <input type="radio" name="send_checkin" id="checkin_no" value="No">
            <label for="checkin_no">No</label>
          </div>
        </div>
        <div class="conditional" id="checkinTextBox">
          <div class="conditional-card">
            <div class="card-title">Check-In Message</div>
            <textarea name="checkin_text" placeholder="Write your check-in message here...&#10;&#10;Example: Hey! It's [Name] here from The Movement Clinic. I wanted to see how you're feeling after our session. Give me an update when you get a chance." rows="5"></textarea>
          </div>
        </div>
      </div>
    </div>

    <!-- Transcript -->
    <div class="card">
      <div class="card-title">Evaluation Transcript</div>
      <div class="field">
        <textarea name="transcript" required placeholder="Paste the full evaluation transcript here..." rows="12"></textarea>
      </div>
    </div>

    <button type="submit" class="submit-btn" id="submitBtn">Submit Evaluation</button>
    <div class="status" id="statusMsg"></div>

  </form>
</div>

<script>
  // Conditional logic
  document.querySelectorAll('input[name="outcome"]').forEach(radio => {
    radio.addEventListener('change', function() {
      document.getElementById('convertedOptions').classList.toggle('visible', this.value === 'Converted');
    });
  });

  document.querySelectorAll('input[name="send_checkin"]').forEach(radio => {
    radio.addEventListener('change', function() {
      document.getElementById('checkinTextBox').classList.toggle('visible', this.value === 'Yes');
    });
  });

  // Form submission
  document.getElementById('evalForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const btn = document.getElementById('submitBtn');
    const status = document.getElementById('statusMsg');
    btn.disabled = true;
    btn.textContent = 'Processing...';
    status.className = 'status loading';
    status.textContent = 'This takes about 90 seconds. Go ahead and close this page when you're ready. Things will continue to process in the background.';

    const data = Object.fromEntries(new FormData(this));

    try {
      const res = await fetch('/post-eval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await res.json();
      if (result.success) {
        status.className = 'status success';
        status.textContent = 'Evaluation submitted successfully. GHL has been updated.';
        this.reset();
        document.querySelectorAll('.conditional').forEach(el => el.classList.remove('visible'));
      } else {
        throw new Error(result.error || 'Unknown error');
      }
    } catch (err) {
      status.className = 'status error';
      status.textContent = 'Something went wrong: ' + err.message + '. Please try again or contact Jordan.';
    }

    btn.disabled = false;
    btn.textContent = 'Submit Evaluation';
  });
</script>
</body>
</html>`);
});

// Handle post-eval form submission
app.post('/post-eval', async (req, res) => {
  try {
    const {
      patient_first_name,
      patient_last_name,
      patient_email,
      patient_phone,
      evaluating_pt,
      outcome,
      stage,
      rehab_essentials,
      send_checkin,
      checkin_text,
      transcript
    } = req.body;

    console.log(`Post-eval submission: ${patient_first_name} ${patient_last_name} — ${outcome}`);

    // Look up GHL contact
    let contact = null;
    try {
      contact = await findGHLContact(patient_phone);
    } catch (err) {
      console.error('Contact lookup by phone failed:', err.message);
    }

    if (!contact && patient_email) {
      try {
        const response = await axios.get(
          `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(patient_email)}`,
          { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
        );
        const contacts = response.data.contacts;
        if (contacts && contacts.length > 0) contact = contacts[0];
      } catch (err) {
        console.error('Contact lookup by email failed:', err.message);
      }
    }

    if (!contact) {
      return res.status(404).json({ error: 'No GHL contact found for this patient. Please check the phone number and email.' });
    }

    console.log(`Found contact: ${contact.id}`);

    // Find or create Customer Pipeline opportunity
    const allOpps = await getAllContactOpportunities(contact.id);
    let customerOpp = allOpps.find(o => o.pipelineId === EVAL_CUSTOMER_PIPELINE_ID && o.status === 'open');
    let customerOppCreated = false;

    if (!customerOpp) {
      console.log('No Customer Pipeline opportunity found — creating one at Evaluation Scheduled');
      const patientFullNameTemp = `${patient_first_name} ${patient_last_name}`;
      customerOpp = await createGHLOpportunity(
        contact.id,
        EVAL_CUSTOMER_PIPELINE_ID,
        EVAL_CUSTOMER_STAGES.EVALUATION_SCHEDULED,
        patientFullNameTemp
      );
      customerOppCreated = true;
      console.log(`Created Customer Pipeline opportunity: ${customerOpp.id}`);
    }

    // Always move to Evaluation Held first and pause 60 seconds for GHL to record the stage
    console.log('Moving to Evaluation Held stage...');
    await updateGHLOpportunity(customerOpp.id, EVAL_CUSTOMER_PIPELINE_ID, EVAL_CUSTOMER_STAGES.EVALUATION_HELD, null);
    console.log('Waiting 60 seconds for GHL to record Evaluation Held stage...');
    await new Promise(resolve => setTimeout(resolve, 60000));
    console.log('60 second pause complete — proceeding with outcome stage');

    // Analyze transcript with Claude
    const claudeResult = await analyzeEvalWithClaude(transcript, outcome);
    console.log(`Claude eval analysis complete: pending_subtype=${claudeResult.pending_subtype}`);

    const ptInfo = PT_CALENDARS[evaluating_pt] || {};
    const planOfCarePT = claudeResult.plan_of_care_pt || evaluating_pt;
    const timestamp = getTimestamp();
    const patientFullName = `${patient_first_name} ${patient_last_name}`;

    // Determine stage update and actions based on outcome
    let newStageId = null;
    let noteLines = ['Claude AI Assistant:', '', `📋 Post-Eval Summary — ${timestamp}`, '', `Outcome: ${outcome}`, `Evaluating PT: ${evaluating_pt}`, `Plan of Care PT: ${planOfCarePT}`];
    if (customerOppCreated) noteLines.push('ℹ️ Customer Pipeline opportunity auto-created (no existing card found).');

    if (outcome === 'Converted') {
      noteLines.push(`Purchase Stage: ${stage}`);
      if (claudeResult.next_steps) noteLines.push(`Next Steps: ${claudeResult.next_steps}`);

      if (stage === 'Stage 1') {
        // Stage 1 — move Customer Pipeline card to Package Purchased
        newStageId = EVAL_CUSTOMER_STAGES.PACKAGE_PURCHASED;
        await sendQuoSMS(patient_phone, STAGE1_TEXT(patient_first_name));
        noteLines.push('✅ Customer Pipeline moved to Package Purchased.');
        noteLines.push('✅ Stage 1 superbill/physician text sent via Quo.');

      } else if (stage === 'Stage 2') {
        // Stage 2 — Customer Pipeline card should already be at Package Purchased
        // Check if it is — if not, update it
        const isAlreadyPurchased = customerOpp.pipelineStageId === EVAL_CUSTOMER_STAGES.PACKAGE_PURCHASED;
        if (!isAlreadyPurchased) {
          newStageId = EVAL_CUSTOMER_STAGES.PACKAGE_PURCHASED;
          noteLines.push('✅ Customer Pipeline moved to Package Purchased (was not already there).');
        } else {
          noteLines.push('ℹ️ Customer Pipeline already at Package Purchased — no stage change needed.');
        }

        // Always create Continuity Pipeline opportunity for Stage 2
        try {
          await createGHLOpportunity(contact.id, CONTINUITY_PIPELINE_ID, CONTINUITY_PURCHASED_STAGE_ID, patientFullName);
          noteLines.push('✅ Continuity Pipeline opportunity created at Continuity Purchased.');
        } catch (err) {
          console.error('Failed to create continuity opportunity:', err.message);
          noteLines.push('⚠️ Failed to create Continuity Pipeline opportunity — please add manually.');
        }

        await sendQuoSMS(patient_phone, STAGE2_TEXT(patient_first_name));
        noteLines.push('✅ Stage 2 superbill/physician text sent via Quo.');
      }

    } else if (outcome === 'Pending') {
      const subtype = claudeResult.pending_subtype;

      if (subtype === 'PENDING_VISIT') {
        newStageId = EVAL_CUSTOMER_STAGES.PENDING_VISIT;
        noteLines.push(`Pending: Follow-Up Visit Booked`);
        if (claudeResult.follow_up_visit_date) noteLines.push(`Visit Date: ${claudeResult.follow_up_visit_date}`);

      } else if (subtype === 'PENDING_CALL') {
        newStageId = EVAL_CUSTOMER_STAGES.PENDING_CALL;
        noteLines.push(`Pending: Follow-Up Call Booked`);
        if (claudeResult.follow_up_call_date) noteLines.push(`Call Date: ${claudeResult.follow_up_call_date}`);
        if (claudeResult.follow_up_call_time) noteLines.push(`Call Time: ${claudeResult.follow_up_call_time}`);

        // Create GHL calendar appointment
        if (claudeResult.follow_up_call_date && claudeResult.follow_up_call_time && ptInfo.calendarId) {
          const ptFirstName = evaluating_pt.split(' ')[0];
          await createGHLCalendarAppointment(
            contact.id,
            ptInfo.calendarId,
            ptInfo.ghlUserId,
            patientFullName,
            ptFirstName,
            claudeResult.follow_up_call_date,
            claudeResult.follow_up_call_time
          );
          noteLines.push(`✅ GHL calendar appointment created for ${evaluating_pt}.`);
        }

      } else {
        // Vague or no firm timeline — use new stage
        newStageId = EVAL_CUSTOMER_STAGES.PENDING_NO_FIRM_TIME;
        noteLines.push('Pending: No firm follow-up time established.');
        if (claudeResult.next_steps) noteLines.push('Context: ' + claudeResult.next_steps);

        // Create task for PT due in 2 days
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 2);
        const taskTitle = 'No established follow-up timeline — call patient to check in (' + patientFullName + ')';
        await createGHLTask(contact.id, taskTitle, dueDate);
        noteLines.push('✅ Follow-up task created — assigned to ' + evaluating_pt + ' (plan of care PT) — due in 2 days.');
      }

    } else if (outcome === 'Lost') {
      newStageId = EVAL_CUSTOMER_STAGES.CLOSED_LOST;
      noteLines.push(`Objection: ${claudeResult.objection_category || 'Not specified'}`);
      if (claudeResult.objection_detail) noteLines.push(`Detail: ${claudeResult.objection_detail}`);

      // Update custom fields on opportunity
      if (claudeResult.objection_category) {
        await updateOpportunityCustomFields(
          customerOpp.id,
          claudeResult.objection_category,
          claudeResult.objection_detail || ''
        );
        noteLines.push('✅ Objection category and detail updated on opportunity.');
      }
    }

    // Add physician info if found
    if (claudeResult.physician_name) {
      noteLines.push(`Physician: ${claudeResult.physician_name}${claudeResult.physician_office ? ` — ${claudeResult.physician_office}` : ''}`);
    }

    // Update Customer Pipeline opportunity stage
    if (newStageId) {
      await updateGHLOpportunity(customerOpp.id, EVAL_CUSTOMER_PIPELINE_ID, newStageId, null);
      console.log(`Customer Pipeline updated to stage: ${newStageId}`);
    }

    // Assign opportunity to plan of care PT
    const planOfCarePTInfo = PT_CALENDARS[planOfCarePT] || PT_CALENDARS[evaluating_pt] || {};
    if (planOfCarePTInfo.ghlUserId && activeOpportunity) {
      await assignOpportunityToUser(activeOpportunity ? activeOpportunity.id : customerOpp.id, planOfCarePTInfo.ghlUserId);
    } else if (planOfCarePTInfo.ghlUserId) {
      await assignOpportunityToUser(customerOpp.id, planOfCarePTInfo.ghlUserId);
    }

    // Add note to contact
    await addNoteToContact(contact.id, noteLines.join('\n'));
    console.log('Note added to contact');

    // Rehab Essentials webhook
    if (rehab_essentials === 'Yes') {
      try {
        await axios.post(REHAB_ESSENTIALS_WEBHOOK, {
          contact_id: contact.id,
          patient_first_name,
          patient_last_name,
          patient_email,
          patient_phone,
          evaluating_pt
        }, { headers: { 'Content-Type': 'application/json' } });
        console.log('Rehab Essentials webhook fired');
      } catch (err) {
        console.error('Failed to fire Rehab Essentials webhook:', err.message);
      }
    }

    // Google Sheet logger webhook
    try {
      await axios.post(GHL_SHEET_WEBHOOK, {
        timestamp: new Date().toISOString(),
        date_added: new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }),
        patient_first_name,
        patient_last_name,
        patient_email,
        patient_phone,
        evaluating_pt,
        plan_of_care_pt: planOfCarePT,
        evaluation_date: new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }),
        conversion_outcome: outcome,
        stage_purchase: stage || 'N/A',
        objection_category: claudeResult.objection_category || '',
        objection_detail: claudeResult.objection_detail || '',
        next_steps: claudeResult.next_steps || '',
        follow_up_visit_date: claudeResult.follow_up_visit_date || '',
        follow_up_call_date: claudeResult.follow_up_call_date || '',
        follow_up_call_time: claudeResult.follow_up_call_time || '',
        physician_name: claudeResult.physician_name || '',
        physician_office: claudeResult.physician_office || '',
        rehab_essentials,
        send_checkin_text: send_checkin,
        checkin_text: checkin_text || ''
      }, { headers: { 'Content-Type': 'application/json' } });
      console.log('Sheet logger webhook fired');
    } catch (err) {
      console.error('Failed to fire sheet logger webhook:', err.message);
    }

    // Build HTML summary email and fire via GHL summary webhook
    const evalSummaryHtml = `
<div style="font-family: 'Montserrat', 'Segoe UI', Arial, sans-serif; max-width: 600px;">
  <p style="font-size:14px; margin:0 0 6px 0;">Hello,</p>
  <p style="font-size:14px; margin:0 0 20px 0;">Here is a summary of all updates made by Claude based on the post-evaluation form submission:</p>

  <table style="width:100%; border-collapse:collapse; background:#eaf4ff; margin-bottom:20px;">
    <tr><td style="padding:14px 16px; border-left:4px solid #2563eb; font-size:14px; font-weight:600; color:#1e3a5f;">
      Post-Eval Outcome: ${outcome}${stage ? ' — ' + stage : ''}
    </td></tr>
  </table>

  <p style="margin:0 0 10px 0; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:1px; color:#888888;">Patient</p>
  <table style="width:100%; border-collapse:collapse; margin-bottom:20px;">
    <tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666; width:45%; border-bottom:1px solid #f0f0f0;">Name</td><td style="padding:9px 0; font-size:13px; color:#333333; border-bottom:1px solid #f0f0f0;">${patientFullName}</td></tr>
    <tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666; border-bottom:1px solid #f0f0f0;">Phone</td><td style="padding:9px 0; font-size:13px; color:#333333; border-bottom:1px solid #f0f0f0;">${patient_phone}</td></tr>
    <tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666; border-bottom:1px solid #f0f0f0;">Email</td><td style="padding:9px 0; font-size:13px; color:#333333; border-bottom:1px solid #f0f0f0;">${patient_email}</td></tr>
    <tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666; border-bottom:1px solid #f0f0f0;">Evaluating PT</td><td style="padding:9px 0; font-size:13px; color:#333333; border-bottom:1px solid #f0f0f0;">${evaluating_pt}</td></tr>
    <tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666;">Plan of Care PT</td><td style="padding:9px 0; font-size:13px; color:#333333;">${planOfCarePT}</td></tr>
  </table>

  <p style="margin:0 0 10px 0; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:1px; color:#888888;">GHL Changes Made</p>
  <table style="width:100%; border-collapse:collapse; margin-bottom:20px;">
    <tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666; width:45%; border-bottom:1px solid #f0f0f0;">Pipeline</td><td style="padding:9px 0; font-size:13px; color:#333333; border-bottom:1px solid #f0f0f0;">Customer Pipeline</td></tr>
    <tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666; border-bottom:1px solid #f0f0f0;">Stage Updated To</td><td style="padding:9px 0; font-size:13px; font-weight:600; color:#0f6e56; border-bottom:1px solid #f0f0f0;">${outcome === 'Converted' ? 'Package Purchased' : outcome === 'Lost' ? 'Closed/Lost' : claudeResult.pending_subtype === 'PENDING_CALL' ? 'Pending - Follow Up Phone Call Booked' : claudeResult.pending_subtype === 'PENDING_VISIT' ? 'Pending - Follow Up Visit Booked' : 'Not a Good Time - Needs Follow Up'}</td></tr>
    ${stage === 'Stage 2' ? '<tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666; border-bottom:1px solid #f0f0f0;">Continuity Pipeline</td><td style="padding:9px 0; font-size:13px; color:#0f6e56; border-bottom:1px solid #f0f0f0;">✅ New opportunity created at Continuity Purchased</td></tr>' : ''}
    ${claudeResult.follow_up_call_date ? '<tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666; border-bottom:1px solid #f0f0f0;">Follow Up Call</td><td style="padding:9px 0; font-size:13px; color:#333333; border-bottom:1px solid #f0f0f0;">' + claudeResult.follow_up_call_date + ' at ' + claudeResult.follow_up_call_time + ' — Calendar appointment created</td></tr>' : ''}
    ${claudeResult.follow_up_visit_date ? '<tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666; border-bottom:1px solid #f0f0f0;">Follow Up Visit</td><td style="padding:9px 0; font-size:13px; color:#333333; border-bottom:1px solid #f0f0f0;">' + claudeResult.follow_up_visit_date + '</td></tr>' : ''}
    ${claudeResult.objection_category ? '<tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666; border-bottom:1px solid #f0f0f0;">Objection Category</td><td style="padding:9px 0; font-size:13px; color:#333333; border-bottom:1px solid #f0f0f0;">' + claudeResult.objection_category + '</td></tr>' : ''}
    ${claudeResult.objection_detail ? '<tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666; border-bottom:1px solid #f0f0f0;">Objection Detail</td><td style="padding:9px 0; font-size:13px; color:#333333; border-bottom:1px solid #f0f0f0;">' + claudeResult.objection_detail + '</td></tr>' : ''}
    <tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666; border-bottom:1px solid #f0f0f0;">Note Added</td><td style="padding:9px 0; font-size:13px; color:#333333; border-bottom:1px solid #f0f0f0;">Yes</td></tr>
    <tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666; border-bottom:1px solid #f0f0f0;">Rehab Essentials</td><td style="padding:9px 0; font-size:13px; color:#333333; border-bottom:1px solid #f0f0f0;">${rehab_essentials}</td></tr>
    <tr><td style="padding:9px 0; font-size:13px; font-weight:600; color:#666666;">Check-In Text Requested</td><td style="padding:9px 0; font-size:13px; color:#333333;">${send_checkin}</td></tr>
  </table>

  ${claudeResult.next_steps ? '<p style="margin:0 0 10px 0; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:1px; color:#888888;">Next Steps</p><p style="margin:0 0 20px 0; font-size:13px; line-height:1.7; color:#333333; background:#f9f9f9; padding:14px; border-radius:6px;">' + claudeResult.next_steps + '</p>' : ''}

  ${claudeResult.physician_name ? '<table style="width:100%; border-collapse:collapse;"><tr><td style="padding:14px 16px; border-left:4px solid #6366f1; background:#eef2ff; font-size:13px; color:#3730a3;"><strong>Physician:</strong> ' + claudeResult.physician_name + (claudeResult.physician_office ? ' — ' + claudeResult.physician_office : '') + '</td></tr></table>' : ''}
</div>`;

    // Build shared payload for both email webhooks
    const evalWebhookPayload = {
      contact_name: String(patientFullName || ''),
      contact_phone: String(patient_phone || ''),
      evaluating_pt: String(evaluating_pt || ''),
      plan_of_care_pt: String(planOfCarePT || ''),
      outcome: String(outcome || ''),
      stage: String(stage || 'N/A'),
      payment_method: String(claudeResult.payment_method || 'Unclear from transcript'),
      evaluation_summary: String(claudeResult.evaluation_summary || ''),
      next_steps: String(claudeResult.next_steps || ''),
      red_flags: String(claudeResult.red_flags || 'None identified.'),
      calendar_appointment_created: String(claudeResult.pending_subtype === 'PENDING_CALL' && claudeResult.follow_up_call_date ? 'Yes — ' + claudeResult.follow_up_call_date + ' at ' + claudeResult.follow_up_call_time : 'No'),
      continuity_opportunity_created: String(stage === 'Stage 2' ? 'Yes — Continuity Purchased' : 'No'),
      rehab_essentials: String(rehab_essentials || ''),
      checkin_text_scheduled: String(send_checkin || ''),
      send_checkin_text: String(send_checkin || ''),
      checkin_text: String(checkin_text || ''),
      objection_category: String(claudeResult.objection_category || ''),
      objection_detail: String(claudeResult.objection_detail || ''),
      physician_name: String(claudeResult.physician_name || ''),
      physician_office: String(claudeResult.physician_office || '')
    };

    // Generate Claude-written email content for post-eval
    try {
      const evalEmailContent = await generateEvalEmailContent({
        contactName: patientFullName,
        contactPhone: patient_phone,
        evaluatingPT: evaluating_pt,
        planOfCarePT: planOfCarePT,
        outcome,
        stage: stage || null,
        paymentMethod: claudeResult.payment_method || 'Unclear from transcript',
        evaluationSummary: claudeResult.evaluation_summary || '',
        nextSteps: claudeResult.next_steps || '',
        redFlags: claudeResult.red_flags || 'None identified.',
        calendarCreated: evalWebhookPayload.calendar_appointment_created,
        continuityCreated: evalWebhookPayload.continuity_opportunity_created,
        rehabEssentials: rehab_essentials,
        checkinScheduled: send_checkin,
        objectionCategory: claudeResult.objection_category || null,
        objectionDetail: claudeResult.objection_detail || null,
        physicianName: claudeResult.physician_name || null,
        physicianOffice: claudeResult.physician_office || null,
        coachingNotes: claudeResult.coaching_notes || 'No coaching notes generated.'
      });

      // Team email — no coaching notes
      await axios.post(EVAL_TEAM_WEBHOOK, {
        email_body: evalEmailContent.team_email_html || '',
        slack_message: evalEmailContent.slack_message || '',
        contact_name: String(patientFullName || ''),
        contact_id: String(contact.id || '')
      }, { headers: { 'Content-Type': 'application/json' } });
      console.log('Team eval webhook fired');

      // Jordan email — includes coaching notes
      await axios.post(EVAL_JORDAN_WEBHOOK, {
        email_body: evalEmailContent.jordan_email_html || '',
        slack_message: evalEmailContent.slack_message || '',
        contact_name: String(patientFullName || ''),
        contact_id: String(contact.id || '')
      }, { headers: { 'Content-Type': 'application/json' } });
      console.log('Jordan eval webhook fired');

    } catch (emailErr) {
      console.error('Failed to generate eval email content:', emailErr.message);
    }

    res.status(200).json({ success: true, outcome, pending_subtype: claudeResult.pending_subtype });

  } catch (error) {
    console.error('Post-eval processing error:', error.response?.data || error.message);

    // Error notification to Jordan
    try {
      await axios.post(EVAL_JORDAN_WEBHOOK, {
        contact_name: req.body.patient_first_name + ' ' + req.body.patient_last_name || 'Unknown',
        contact_phone: req.body.patient_phone || 'Unknown',
        evaluating_pt: req.body.evaluating_pt || 'Unknown',
        outcome: 'ERROR — Form submission failed',
        stage: 'N/A',
        payment_method: 'N/A',
        evaluation_summary: 'The post-eval form failed to process. Manual GHL update required.',
        next_steps: 'Check Railway logs immediately and update GHL manually.',
        red_flags: 'SYSTEM ERROR: ' + (error.message || 'Unknown error'),
        calendar_appointment_created: 'N/A',
        continuity_opportunity_created: 'N/A',
        rehab_essentials: 'N/A',
        checkin_text_scheduled: 'N/A',
        send_checkin_text: 'N/A',
        checkin_text: '',
        objection_category: '',
        objection_detail: '',
        physician_name: '',
        physician_office: '',
        coaching_notes: 'No coaching notes — form processing failed before analysis completed.'
      }, { headers: { 'Content-Type': 'application/json' } });
    } catch (notifyErr) {
      console.error('Failed to send error notification:', notifyErr.message);
    }

    res.status(500).json({ error: error.message });
  }
});


// ── Open Charts Email ─────────────────────────────────────────────────────────
async function sendOpenChartsEmail(toEmail, ptName, charts, submissionDate) {
  const firstName = ptName.split(' ')[0];
  const hasCharts = charts.length > 0;

  let bodyHtml;
  if (!hasCharts) {
    bodyHtml = `
<div style="text-align:center; padding:48px 32px;">
  <div style="font-size:80px; line-height:1; margin-bottom:16px;">⭐</div>
  <h2 style="font-size:24px; font-weight:700; color:#232323; margin:0 0 10px;">No Open Charts!</h2>
  <p style="font-size:15px; color:#6b7280; font-weight:500; margin:0;">You're all caught up, ${firstName}. Great work this week!</p>
</div>`;
  } else {
    const rows = charts.map((c, i) => `
<tr style="background:${i % 2 === 0 ? '#F7F8FA' : '#ffffff'};">
  <td style="padding:10px 14px; font-size:13px; font-weight:600; color:#232323; border-bottom:1px solid #e5e7eb;">${c.patient}</td>
  <td style="padding:10px 14px; font-size:13px; color:#6b7280; border-bottom:1px solid #e5e7eb;">${c.date}</td>
  <td style="padding:10px 14px; font-size:13px; color:#6b7280; border-bottom:1px solid #e5e7eb;">${c.service}</td>
</tr>`).join('');

    bodyHtml = `
<p style="font-size:14px; color:#374151; line-height:1.6; margin:0 0 20px;">
  Hey ${firstName}! 👋 Here's a quick look at your <strong>${charts.length} open chart${charts.length !== 1 ? 's' : ''}</strong> as of ${submissionDate}. Please close these out before the next weekly meeting.
</p>
<table style="width:100%; border-collapse:collapse; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;">
  <thead>
    <tr style="background:#232323;">
      <th style="padding:11px 14px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#FFD70A; text-align:left;">Patient</th>
      <th style="padding:11px 14px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#FFD70A; text-align:left;">Appointment Date</th>
      <th style="padding:11px 14px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#FFD70A; text-align:left;">Service</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
<p style="font-size:12px; color:#9ca3af; margin:16px 0 0;">Close these in PTEverywhere before your next weekly meeting. Thanks! 🙌</p>`;
  }

  const emailHtml = `
<div style="font-family:'Montserrat','Segoe UI',Arial,sans-serif; max-width:600px; margin:0 auto; background:#F7F8FA;">
  <div style="background:#232323; padding:20px 24px; border-bottom:3px solid #FFD70A;">
    <p style="color:#F7F8FA; font-size:13px; font-weight:700; margin:0; letter-spacing:0.5px;">MOVEMENT CLINIC PT · OPEN CHARTS REMINDER</p>
  </div>
  <div style="padding:28px 32px; background:#ffffff; border:1px solid #e5e7eb; border-top:none;">
    ${bodyHtml}
  </div>
  <div style="padding:14px 24px; text-align:center;">
    <p style="font-size:11px; color:#9ca3af; margin:0;">Generated ${submissionDate} · Movement Clinic Weekly Metrics</p>
  </div>
</div>`;

  const { google } = require('googleapis');
  const SERVICE_ACCOUNT_JSON = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!SERVICE_ACCOUNT_JSON.client_email) throw new Error('No service account configured');

  const auth = new google.auth.JWT({
    email: SERVICE_ACCOUNT_JSON.client_email,
    key:   SERVICE_ACCOUNT_JSON.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    subject: process.env.GMAIL_USER,
  });
  await auth.authorize();
  const gmail = google.gmail({ version: 'v1', auth });

  const subject = hasCharts
    ? `📋 You have ${charts.length} open chart${charts.length !== 1 ? 's' : ''} — ${firstName}`
    : `⭐ No open charts this week — ${firstName}`;

  const messageParts = [
    `From: ${process.env.GMAIL_USER}`,
    `To: ${toEmail}`,
    `Subject: ${subject}`,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    emailHtml,
  ];
  const raw = Buffer.from(messageParts.join('\n')).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// ============================================================
// METRICS UPLOAD PAGE
// ============================================================

const multer = require('multer');
const csv = require('csv-parse/sync');
const pdfParse = require('pdf-parse');
const { google } = require('googleapis');

const metricsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const CLINIC_METRICS_SHEET_ID = '1ej2f-8W7pE8ydVR6TOOdP246Zmm9hU974FJL0cJJ8sE';
const POST_EVAL_SHEET_ID = '1z6Y8eRaTNtiwJySGplMUaD-yJwq4M6vkQl2IzM3tJsI';

const PT_TABS = {
  'Chris Bostwick': 'Chris Bostwick Metrics',
  'TJ Aquino':      'TJ Aquino Metrics',
  'John Gan':       'John Gan Metrics',
  'Jordan McCormack': 'Jordan McCormack Metrics'
};
const CLINIC_TAB = 'Clinic Metrics';

// Month name → row offset within a monthly table (Jan=data row 1, Feb=2, etc.)
const MONTH_ROWS = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Year → column letter (2021=B, 2022=C, ... 2026=G)
function yearToCol(year) {
  const cols = { 2021:'B',2022:'C',2023:'D',2024:'E',2025:'F',2026:'G' };
  return cols[year] || 'G';
}

// Week of month (1-5) → column letter (Week1=B, Week2=C, etc.)
function weekToCol(week) {
  return ['B','C','D','E','F'][week - 1] || 'B';
}

// Calculate which week of the month a date falls in (1-5)
function getWeekOfMonth(date) {
  const day = date.getDate();
  return Math.ceil(day / 7);
}

// Row anchors for each table on Clinic tab and PT tabs
// Based on screenshots: each table = title row + header row + 12 month rows + blank + Total + Avg + %Growth = 19 rows, tables separated by ~1 blank row
const TABLE_ANCHORS = {
  clinic: {
    totalLeads:          { titleRow: 1,   dataStartRow: 3  }, // Clinic only
    totalEvals:          { titleRow: 20,  dataStartRow: 22 },
    totalConversions:    { titleRow: 39,  dataStartRow: 41 },
    totalVisits:         { titleRow: 58,  dataStartRow: 60 },
    totalCancels24hr:    { titleRow: 77,  dataStartRow: 79 },
    totalLateCancels:    { titleRow: 96,  dataStartRow: 98 },
    totalOpenCharts:     { titleRow: 115, dataStartRow: 117, weekTable: true },
    totalOverdueTasks:   { titleRow: 134, dataStartRow: 136, weekTable: true }
  },
  pt: {
    totalEvals:          { titleRow: 1,   dataStartRow: 3  },
    totalConversions:    { titleRow: 20,  dataStartRow: 22 },
    totalVisits:         { titleRow: 39,  dataStartRow: 41 },
    totalCancels24hr:    { titleRow: 58,  dataStartRow: 60 },
    totalLateCancels:    { titleRow: 77,  dataStartRow: 79 },
    totalOverdueTasks:   { titleRow: 96,  dataStartRow: 98,  weekTable: true },
    totalOpenCharts:     { titleRow: 115, dataStartRow: 117, weekTable: true }
  }
};

function getGoogleSheetsClient() {
  const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: saJson,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

// Build A1 notation for a monthly table cell
function monthlyCell(anchor, monthName, year) {
  const monthOffset = MONTH_ROWS[monthName];
  if (!monthOffset) return null;
  const row = anchor.dataStartRow + monthOffset - 1;
  const col = yearToCol(year);
  return `${col}${row}`;
}

// Build A1 notation for a weekly table cell
function weeklyCell(anchor, monthName, week) {
  const monthOffset = MONTH_ROWS[monthName];
  if (!monthOffset) return null;
  const row = anchor.dataStartRow + monthOffset - 1;
  const col = weekToCol(week);
  return `${col}${row}`;
}

// Parse GeneralVisitReport CSV → per-PT counts
function parseGeneralVisitReport(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split('\n').filter(l => l.trim());
  const data = {};
  const PT_NAMES = ['Chris Bostwick','TJ Aquino','John Gan','Jordan McCormack'];
  for (const pt of PT_NAMES) data[pt] = { evals: 0, visits: 0, continuity: 0, complimentary: 0 };

  for (const line of lines) {
    if (line.startsWith('Group By') || !line.trim()) continue;
    const cols = line.split(',');
    const provider = cols[4]?.trim().replace(/^"|"$/g,'');
    const service = cols[5]?.trim().replace(/^"|"$/g,'');
    if (!provider || !PT_NAMES.includes(provider)) continue;
    data[provider].visits++;
    if (service && (service.toLowerCase().includes('evaluation') || service.includes('$50 Comprehensive'))) {
      data[provider].evals++;
    }
    if (service && service.toLowerCase().includes('continuity')) {
      data[provider].continuity++;
    }
    if (service && service.toLowerCase().includes('complimentary')) {
      data[provider].complimentary++;
    }
  }
  return data;
}

// Parse AppointmentMetricsReport CSV → per-PT schedule efficiency
function parseAppointmentMetrics(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split('\n').filter(l => l.trim());
  const data = {};
  for (const line of lines) {
    if (line.startsWith('Therapist') || !line.trim()) continue;
    const cols = line.split(',');
    const therapist = cols[0]?.trim();
    const pctBooked = cols[3]?.trim().replace('%','');
    if (therapist && pctBooked) data[therapist] = parseFloat(pctBooked);
  }
  return data;
}

// Parse CancellationReport CSV → per-PT counts split by >24hr and <=24hr
function parseCancellations(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split('\n').filter(l => l.trim());
  const PT_NAMES = ['Chris Bostwick','TJ Aquino','John Gan','Jordan McCormack'];
  const data = {};
  for (const pt of PT_NAMES) data[pt] = { over24: 0, lateCancelNoShow: 0 };

  for (const line of lines) {
    if (line.startsWith('First Name') || !line.trim()) continue;
    // CSV: First Name,Last Name,Phone,Email,Cancellation Notice,Appointment,Service,Provider,...
    const cols = line.split(',');
    const noticeStr = cols[4]?.trim().replace(/^"|"$/g,'').replace(' hrs','');
    const provider = cols[7]?.trim().replace(/^"|"$/g,'');
    if (!provider || !PT_NAMES.includes(provider)) continue;
    const notice = parseFloat(noticeStr);
    if (isNaN(notice)) continue;
    if (notice > 24) {
      data[provider].over24++;
    } else {
      data[provider].lateCancelNoShow++;
    }
  }
  return data;
}

// Parse ChartingReport CSV → per-PT open chart count (excludes Jordan)
function parseChartingReport(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split('\n').filter(l => l.trim());
  const counts = { 'Chris Bostwick': 0, 'TJ Aquino': 0, 'John Gan': 0 };
  const rows   = { 'Chris Bostwick': [], 'TJ Aquino': [], 'John Gan': [] };
  for (const line of lines) {
    if (line.startsWith('Group By') || !line.trim()) continue;
    const cols      = line.split(',');
    const firstName = cols[1]?.trim().replace(/^"|"$/g,'');
    const lastName  = cols[2]?.trim().replace(/^"|"$/g,'');
    const apptDate  = cols[3]?.trim().replace(/^"|"$/g,'');
    const provider  = cols[4]?.trim().replace(/^"|"$/g,'');
    const service   = cols[5]?.trim().replace(/^"|"$/g,'');
    if (counts.hasOwnProperty(provider)) {
      counts[provider]++;
      rows[provider].push({ patient: firstName + ' ' + lastName, date: apptDate, service });
    }
  }
  return { counts, rows };
}

// Extract total leads number from GHL PDF using Claude vision
async function extractLeadsFromPdf(buffer) {
  try {
    // First try pdf-parse for text extraction
    const parsed = await pdfParse(buffer);
    const text = parsed.text;
    // Look for a large number pattern — the leads count
    const match = text.match(/\b(\d{1,4})\b/);
    if (match) return parseInt(match[1]);
  } catch(e) { /* fall through to Claude */ }

  // Fallback: send to Claude as base64 image
  const base64 = buffer.toString('base64');
  const resp = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: 'This is a GHL "Total Leads This Month" report. Return ONLY the total leads number as a plain integer, nothing else.' }
      ]
    }]
  }, {
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
  });
  const raw = resp.data.content[0].text.trim();
  return parseInt(raw.replace(/\D/g,'')) || 0;
}

// Read post-eval sheet and count conversions by PT for a given month/year
const NOTION_CONVERSIONS_DB = '27fe3256aaa180aabf9de53d42298016';
const MONTH_FULL_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const PT_NAMES_ALL = ['Chris Bostwick','TJ Aquino','John Gan','Jordan McCormack'];

// Pull Package Purchased conversions from Notion (historical source)
// Returns { 'April 2026': { clinic: N, pts: { 'Chris Bostwick': N, ... } } }
async function getNotionConversions() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error('NOTION_TOKEN not set');

  // Email → PT name map for fallback when Evaluating Physical Therapist is blank
  const EMAIL_TO_PT = {
    'chris@movementclinicpt.com': 'Chris Bostwick',
    'tj@movementclinicpt.com':    'TJ Aquino',
    'john@movementclinicpt.com':  'John Gan',
    'jordan@movementclinicpt.com':'Jordan McCormack'
  };

  const results = [];
  let cursor = undefined;
  do {
    // Notion cannot filter on formula fields — fetch all records and filter client-side
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const resp = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_CONVERSIONS_DB}/query`, body,
      { headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
    );
    results.push(...resp.data.results);
    cursor = resp.data.has_more ? resp.data.next_cursor : undefined;
  } while (cursor);

  const byMonth = {};
  for (const page of results) {
    const props = page.properties;

    // Month Key is a formula string field
    const monthKey = props['Month Key']?.formula?.string || '';
    if (!monthKey) continue;

    // Filter client-side: only count Package Purchased (Deal Outcome is a formula)
    const dealOutcome = props['Deal Outcome']?.formula?.string || '';
    if (dealOutcome !== 'Package Purchased') continue;

    // Evaluating Physical Therapist is multi_select — may be empty
    // Fall back to Employee Email formula field to derive PT name
    const ptFromSelect = props['Evaluating Physical Therapist']?.multi_select?.[0]?.name || '';
    const empEmail = props['Employee Email']?.formula?.string || '';
    const pt = ptFromSelect || EMAIL_TO_PT[empEmail] || '';

    if (!byMonth[monthKey]) { byMonth[monthKey] = { clinic: 0, pts: {} }; for (const p of PT_NAMES_ALL) byMonth[monthKey].pts[p] = 0; }
    byMonth[monthKey].clinic++;
    if (pt && PT_NAMES_ALL.includes(pt)) byMonth[monthKey].pts[pt]++;

    // Also track Pending (no subtype breakdown available in Notion)
    const isPending = props['Deal Outcome']?.formula?.string === 'Pending';
    if (isPending) {
      byMonth[monthKey].pendingNotion = (byMonth[monthKey].pendingNotion || 0) + 1;
    }
  }
  return byMonth;
}

// Pull Package Purchased conversions from Railway post-eval Google Sheet (ongoing source)
// Returns same shape: { 'April 2026': { clinic: N, pts: { ... } } }
async function getSheetConversions() {
  const sheets = getGoogleSheetsClient();
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: POST_EVAL_SHEET_ID, range: 'Sheet1!A:Z' });
  const rows = result.data.values || [];
  if (rows.length < 2) return {};

  const headers = rows[0].map(h => h.toLowerCase().trim());
  const outcomeIdx    = headers.findIndex(h => h.includes('outcome') && !h.includes('subtype'));
  const subtypeIdx    = headers.findIndex(h => h.includes('pending subtype') || h.includes('pending_subtype'));
  const ptIdx         = headers.findIndex(h => h.includes('evaluating pt') || h === 'evaluating_pt');
  const tsIdx         = headers.findIndex(h => h.includes('timestamp'));

  const byMonth = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const outcome  = row[outcomeIdx]?.trim() || '';
    const subtype  = row[subtypeIdx]?.trim().toUpperCase() || '';
    const pt       = row[ptIdx]?.trim() || '';
    const ts       = row[tsIdx]?.trim() || '';
    if (!outcome || !ts) continue;
    const d = new Date(ts);
    if (isNaN(d.getTime())) continue;
    const monthKey = `${MONTH_FULL_NAMES[d.getMonth()]} ${d.getFullYear()}`;
    if (!byMonth[monthKey]) {
      byMonth[monthKey] = { clinic: 0, pts: {}, pendingVisit: 0, pendingCall: 0 };
      for (const p of PT_NAMES_ALL) byMonth[monthKey].pts[p] = 0;
    }

    const outcomeLower = outcome.toLowerCase();
    if (outcomeLower.includes('convert')) {
      byMonth[monthKey].clinic++;
      if (pt && PT_NAMES_ALL.includes(pt)) byMonth[monthKey].pts[pt]++;
    } else if (outcomeLower === 'pending') {
      if (subtype === 'PENDING_VISIT') byMonth[monthKey].pendingVisit++;
      else if (subtype === 'PENDING_CALL') byMonth[monthKey].pendingCall++;
    }
  }
  return byMonth;
}

// Merge Notion (historical) + Google Sheet (ongoing) conversions — both sources summed
async function getAllConversions() {
  const [notionData, sheetData] = await Promise.allSettled([getNotionConversions(), getSheetConversions()]);
  const notion = notionData.status === 'fulfilled' ? notionData.value : {};
  const sheet  = sheetData.status  === 'fulfilled' ? sheetData.value  : {};

  const merged = {};
  const allKeys = new Set([...Object.keys(notion), ...Object.keys(sheet)]);
  for (const key of allKeys) {
    merged[key] = { clinic: 0, pts: {}, pendingVisit: 0, pendingCall: 0, pendingNotion: 0 };
    for (const p of PT_NAMES_ALL) merged[key].pts[p] = 0;
    if (notion[key]) {
      merged[key].clinic       += notion[key].clinic || 0;
      merged[key].pendingNotion += notion[key].pendingNotion || 0;
      for (const p of PT_NAMES_ALL) merged[key].pts[p] += notion[key].pts[p] || 0;
    }
    if (sheet[key]) {
      merged[key].clinic       += sheet[key].clinic || 0;
      merged[key].pendingVisit += sheet[key].pendingVisit || 0;
      merged[key].pendingCall  += sheet[key].pendingCall || 0;
      for (const p of PT_NAMES_ALL) merged[key].pts[p] += sheet[key].pts[p] || 0;
    }
  }
  return merged;
}

// Get conversions for a specific month/year — used during metrics submit
async function getEvalConversions(month, year) {
  const monthIdx = MONTH_NAMES.indexOf(month);
  if (monthIdx === -1) return {};
  const monthKey = `${MONTH_FULL_NAMES[monthIdx]} ${year}`;
  const counts = {};
  for (const pt of PT_NAMES_ALL) counts[pt] = 0;
  try {
    const all = await getAllConversions();
    const md = all[monthKey];
    if (!md) return counts;
    for (const pt of PT_NAMES_ALL) counts[pt] = md.pts[pt] || 0;
  } catch(e) { console.error('getEvalConversions failed:', e.message); }
  return counts;
}

// Write a batch of cell updates to Google Sheets
async function writeSheetUpdates(updates) {
  // updates = [{ sheetName, cell, value }]
  const sheets = getGoogleSheetsClient();
  const data = updates.map(u => ({
    range: `${u.sheetName}!${u.cell}`,
    values: [[u.value]]
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: CLINIC_METRICS_SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data }
  });
}

// GET /metrics — serve the upload form
app.get('/metrics', (req, res) => {
  const now = new Date();
  const monthName = MONTH_NAMES[now.getMonth()];
  const year = now.getFullYear();
  const weekNum = getWeekOfMonth(now);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Weekly Metrics Upload — Movement Clinic PT</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --dark: #232323;
    --yellow: #FFD70A;
    --bg: #F7F8FA;
    --blue: #0065a3;
    --blue-light: #e0f0fa;
    --mid: #6b7280;
    --border: #e5e7eb;
    --white: #ffffff;
    --green-bg: #dcfce7;
    --green-text: #166534;
    --red: #ef4444;
  }

  body {
    font-family: 'Montserrat', 'Segoe UI', Arial, sans-serif;
    background: var(--bg);
    color: var(--dark);
    min-height: 100vh;
    padding: 0 0 80px;
  }

  /* Topbar */
  .topbar {
    background: var(--dark);
    border-bottom: 3px solid var(--yellow);
    padding: 18px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 40px;
  }

  .topbar-left {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .topbar-logo {
    width: 36px; height: 36px;
    background: var(--yellow);
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
  }

  .topbar-logo svg { width: 20px; height: 20px; fill: var(--dark); }

  .topbar h1 {
    font-size: 16px;
    font-weight: 700;
    color: var(--white);
    letter-spacing: 0.01em;
  }

  .topbar p {
    font-size: 11px;
    color: #9ca3af;
    margin-top: 1px;
    font-weight: 500;
  }

  .topbar-badge {
    background: rgba(255,215,10,0.15);
    color: var(--yellow);
    font-size: 11px;
    font-weight: 700;
    padding: 5px 14px;
    border-radius: 20px;
    border: 1px solid rgba(255,215,10,0.3);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .container {
    max-width: 720px;
    margin: 0 auto;
    padding: 0 20px;
  }

  .card {
    background: var(--white);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 28px 32px;
    margin-bottom: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }

  .card-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--mid);
    margin-bottom: 20px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  /* Drop zone */
  .drop-zone {
    border: 2px dashed var(--border);
    border-radius: 10px;
    padding: 36px 24px;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
    background: var(--bg);
    position: relative;
  }

  .drop-zone:hover, .drop-zone.drag-over {
    border-color: var(--blue);
    background: var(--blue-light);
  }

  .drop-zone input[type="file"] {
    position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;
  }

  .drop-icon {
    width: 44px; height: 44px;
    background: var(--dark);
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto 14px;
  }

  .drop-icon svg { width: 22px; height: 22px; fill: var(--yellow); }

  .drop-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--dark);
    margin-bottom: 6px;
  }

  .drop-sub {
    font-size: 12px;
    color: var(--mid);
    font-weight: 500;
    line-height: 1.6;
  }

  .drop-sub strong { color: var(--dark); }

  /* File list */
  .file-list {
    margin-top: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .file-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12px;
  }

  .file-item-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .file-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--green-text);
    flex-shrink: 0;
  }

  .file-dot.unmatched { background: var(--red); }

  .file-name {
    font-weight: 600;
    color: var(--dark);
  }

  .file-type {
    font-size: 11px;
    color: var(--mid);
    font-weight: 500;
  }

  .file-remove {
    background: none;
    border: none;
    color: var(--mid);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .file-remove:hover { color: var(--red); background: #fee2e2; }

  /* Tasks section */
  .task-instructions {
    font-size: 14px;
    font-weight: 600;
    color: var(--dark);
    background: #FFF8E1;
    border: 1px solid var(--yellow);
    border-radius: 8px;
    padding: 14px 18px;
    margin-bottom: 20px;
    line-height: 1.6;
  }

  .task-instructions .inst-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--dark);
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .task-instructions ol {
    padding-left: 20px;
    font-size: 13px;
    font-weight: 500;
    color: #4b3800;
  }

  .task-instructions ol li { margin-bottom: 4px; }

  .task-instructions .warn {
    font-size: 12px;
    font-weight: 700;
    color: #92400e;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid rgba(255,215,10,0.4);
  }

  .task-table {
    width: 100%;
    border-collapse: collapse;
  }

  .task-table th {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--mid);
    text-align: left;
    padding: 0 0 12px;
  }

  .task-table th:last-child { text-align: right; }

  .task-table td {
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }

  .pt-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--dark);
  }

  .pt-role {
    font-size: 11px;
    color: var(--mid);
    margin-top: 2px;
    font-weight: 500;
  }

  .task-input {
    width: 100px;
    text-align: right;
    padding: 9px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 14px;
    font-family: 'Montserrat', sans-serif;
    font-weight: 600;
    color: var(--dark);
    background: var(--bg);
    display: block;
    margin-left: auto;
    transition: border-color 0.15s, background 0.15s;
  }

  .task-input:focus { outline: none; border-color: var(--blue); background: white; }

  /* Submit */
  .submit-btn {
    display: block;
    width: 100%;
    padding: 16px;
    background: var(--dark);
    color: var(--white);
    font-family: 'Montserrat', sans-serif;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.15s, transform 0.1s;
    margin-top: 24px;
  }

  .submit-btn:hover { background: var(--blue); }
  .submit-btn:active { transform: scale(0.99); }
  .submit-btn:disabled { background: #9ca3af; cursor: not-allowed; }

  .status-bar {
    margin-top: 16px;
    padding: 14px 20px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    display: none;
  }

  .status-bar.processing { background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; display: block; }
  .status-bar.success { background: var(--green-bg); color: var(--green-text); border: 1px solid #bbf7d0; display: block; }
  .status-bar.error { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; display: block; }
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-left">
    <div class="topbar-logo">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M13.5 2c-5.621 0-10.211 4.443-10.475 10h-3.025l5 6.625 5-6.625h-2.975c.257-3.351 3.06-6 6.475-6 3.584 0 6.5 2.916 6.5 6.5s-2.916 6.5-6.5 6.5c-1.863 0-3.542-.793-4.728-2.053l-2.427 3.216c1.877 1.754 4.389 2.837 7.155 2.837 5.79 0 10.5-4.71 10.5-10.5s-4.71-10.5-10.5-10.5z"/>
      </svg>
    </div>
    <div>
      <h1>Weekly Metrics Upload</h1>
      <p>Movement Clinic Physical Therapy</p>
    </div>
  </div>
  <div class="topbar-badge">${monthName} ${year} · Week ${weekNum}</div>
</div>

<div class="container">
<form id="metricsForm" enctype="multipart/form-data">
  <input type="hidden" name="week" value="${weekNum}">

  <!-- Month Selector Card -->
  <div class="card" style="margin-bottom:20px;">
    <div class="card-title">Submission Period</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:end;">
      <div>
        <label style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#6b7280; margin-bottom:8px;">Month</label>
        <select name="month" id="monthSelect" onchange="checkMonthLock()" style="width:100%; padding:10px 14px; border:1px solid #e5e7eb; border-radius:8px; font-family:'Montserrat',sans-serif; font-size:13px; font-weight:600; color:#232323; background:#F7F8FA; cursor:pointer;">
          ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m,i) => {
            const selected = i === now.getMonth() ? 'selected' : '';
            return `<option value="${m}" ${selected}>${new Date(2026,i,1).toLocaleString('default',{month:'long'})}</option>`;
          }).join('')}
        </select>
      </div>
      <div>
        <label style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#6b7280; margin-bottom:8px;">Year</label>
        <select name="year" id="yearSelect" onchange="checkMonthLock()" style="width:100%; padding:10px 14px; border:1px solid #e5e7eb; border-radius:8px; font-family:'Montserrat',sans-serif; font-size:13px; font-weight:600; color:#232323; background:#F7F8FA; cursor:pointer;">
          <option value="2024">2024</option>
          <option value="2025">2025</option>
          <option value="2026" selected>2026</option>
          <option value="2027">2027</option>
        </select>
      </div>
    </div>

    <!-- Lock warning — shown when month is outside allowed window -->
    <div id="lockWarning" style="display:none; margin-top:16px; background:#FEE2E2; border:1px solid #FECACA; border-radius:8px; padding:14px 18px;">
      <div style="font-size:13px; font-weight:700; color:#991B1B; margin-bottom:8px;">⚠️ Finalized Month — Overwrite Requires Authorization</div>
      <div style="font-size:12px; font-weight:500; color:#7F1D1D; margin-bottom:12px;">This month is outside the allowed submission window and is considered finalized. Overwriting requires Jordan's PIN.</div>
      <label style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#991B1B; margin-bottom:6px;">Authorization PIN</label>
      <input type="password" id="overwritePin" maxlength="10" placeholder="Enter PIN to authorize overwrite" style="width:100%; max-width:280px; padding:9px 14px; border:1px solid #FECACA; border-radius:8px; font-family:'Montserrat',sans-serif; font-size:13px; font-weight:600; color:#232323; background:#FFF5F5;">
    </div>
  </div>

  <!-- Report Uploads -->
  <div class="card">
    <div class="card-title">Report Uploads</div>

    <div id="dateRangeBanner" style="background:#232323; border-radius:8px; padding:14px 20px; margin-bottom:20px; text-align:center;">
      <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; color:#FFD70A; margin-bottom:4px;">Report Date Range</div>
      <div id="dateRangeText" style="font-size:18px; font-weight:700; color:#ffffff; letter-spacing:0.02em;">${monthName} 1 – ${monthName} ${new Date(year, now.getMonth()+1, 0).getDate()}, ${year}</div>
      <div style="font-size:11px; color:#9ca3af; margin-top:4px; font-weight:500;">Set this date range when exporting all reports</div>
    </div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px;">
      <div style="background:#F7F8FA; border:1px solid #e5e7eb; border-radius:8px; padding:16px;">
        <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#6b7280; margin-bottom:10px;">PTEverywhere Reports</div>
        <ul style="list-style:none; padding:0; font-size:12px; font-weight:600; color:#232323; display:flex; flex-direction:column; gap:7px;">
          <li style="display:flex; align-items:flex-start; gap:8px;"><span style="color:#0065a3; flex-shrink:0;">→</span> General Visit Report</li>
          <li style="display:flex; align-items:flex-start; gap:8px;"><span style="color:#0065a3; flex-shrink:0;">→</span> Appointment Metrics Report</li>
          <li style="display:flex; align-items:flex-start; gap:8px;"><span style="color:#0065a3; flex-shrink:0;">→</span> Cancellation Report</li>
          <li style="display:flex; align-items:flex-start; gap:8px; line-height:1.4;"><span style="color:#0065a3; flex-shrink:0;">→</span><span>Charting Report <span style="display:block; font-size:11px; font-weight:500; color:#ef4444; margin-top:2px;">⚠ This report only: exclude Jordan McCormack. Including him will throw off the open charts data. All other reports should include all providers.</span></span></li>
        </ul>
      </div>
      <div style="background:#F7F8FA; border:1px solid #e5e7eb; border-radius:8px; padding:16px;">
        <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#6b7280; margin-bottom:10px;">GHL Report</div>
        <ul style="list-style:none; padding:0; font-size:12px; font-weight:600; color:#232323; display:flex; flex-direction:column; gap:7px;">
          <li style="display:flex; align-items:flex-start; gap:8px;"><span style="color:#0065a3; flex-shrink:0;">→</span><span>Total Leads This Month <span style="display:block; font-size:11px; font-weight:500; color:#6b7280; margin-top:2px;">Export as PDF from GHL Reporting</span></span></li>
        </ul>
      </div>
    </div>

    <div class="drop-zone" id="dropZone">
      <input type="file" id="fileInput" multiple accept=".csv,.pdf">
      <div class="drop-icon">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>
      </div>
      <div class="drop-title">Drop all 5 report files here</div>
      <div class="drop-sub">
        or click to browse — accepts <strong>CSV</strong> and <strong>PDF</strong><br>
        Files are identified automatically by their export filename
      </div>
    </div>

    <div class="file-list" id="fileList"></div>
  </div>

  <!-- Overdue Tasks Manual Entry -->
  <div class="card">
    <div class="card-title">Overdue Tasks — Manual Entry</div>

    <div class="task-instructions">
      <div class="inst-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#92400e" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        How to find overdue task counts in GHL
      </div>
      <ol>
        <li>Go to <strong>Contacts</strong> in GHL → click the <strong>Tasks</strong> tab in the left nav</li>
        <li>Use the <strong>filter icon</strong> to filter by <strong>Assignee</strong> and set Status to <strong>Incomplete</strong></li>
        <li>Sort by <strong>Due Date (oldest first)</strong> to see overdue tasks at the top</li>
        <li>Count only tasks with a due date <strong>before today</strong> — enter that number below</li>
        <li>Repeat for each provider</li>
      </ol>
      <div class="warn">⚠️ Enter OVERDUE tasks only (past due date) — do not include tasks due today or in the future</div>
    </div>

    <table class="task-table">
      <thead>
        <tr>
          <th>Provider</th>
          <th>Overdue Tasks</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <div class="pt-name">Chris Bostwick</div>
            <div class="pt-role">Physical Therapist</div>
          </td>
          <td>
            <input type="number" class="task-input" name="tasks_chris" min="0" value="0">
          </td>
        </tr>
        <tr>
          <td>
            <div class="pt-name">TJ Aquino</div>
            <div class="pt-role">Physical Therapist</div>
          </td>
          <td>
            <input type="number" class="task-input" name="tasks_tj" min="0" value="0">
          </td>
        </tr>
        <tr>
          <td>
            <div class="pt-name">John Gan</div>
            <div class="pt-role">Physical Therapist</div>
          </td>
          <td>
            <input type="number" class="task-input" name="tasks_john" min="0" value="0">
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <button type="button" class="submit-btn" id="submitBtn" onclick="submitMetrics()">
    Upload &amp; Update Google Sheet
  </button>
  <div class="status-bar" id="statusBar"></div>
</form>
</div>

<script>
// Month names for date range display
const MONTH_NAMES_JS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_DAYS = [31,28,31,30,31,30,31,31,30,31,30,31];
const MONTH_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function isLeapYear(y) { return (y%4===0 && y%100!==0) || y%400===0; }
function daysInMonth(m, y) {
  const idx = MONTH_NAMES_JS.indexOf(m);
  if (idx === 1) return isLeapYear(y) ? 29 : 28;
  return MONTH_DAYS[idx];
}

function checkMonthLock() {
  const month = document.getElementById('monthSelect').value;
  const year  = parseInt(document.getElementById('yearSelect').value);
  const now   = new Date();
  const curMonth = MONTH_NAMES_JS[now.getMonth()];
  const curYear  = now.getFullYear();

  // Update date range banner
  const days = daysInMonth(month, year);
  const idx  = MONTH_NAMES_JS.indexOf(month);
  document.getElementById('dateRangeText').textContent =
    MONTH_FULL[idx] + ' 1 – ' + MONTH_FULL[idx] + ' ' + days + ', ' + year;

  // Determine if month is within allowed window
  // Allowed: current month, or prior month if within 7 days of month end
  const submitDate = now;
  const sevenDayGrace = new Date(curYear, now.getMonth(), 8); // 7 days into current month
  const isPriorMonth  = (year === curYear && idx === now.getMonth() - 1) ||
                        (year === curYear - 1 && idx === 11 && now.getMonth() === 0);
  const isCurrent     = (year === curYear && month === curMonth);
  const inGrace       = isPriorMonth && submitDate < sevenDayGrace;
  const isLocked      = !isCurrent && !inGrace;

  document.getElementById('lockWarning').style.display = isLocked ? 'block' : 'none';
  document.getElementById('overwritePin').value = '';
}

// Init on load
checkMonthLock();

// File type detection by filename
const FILE_PATTERNS = {
  generalVisits:      /GeneralVisit|General_Visit/i,
  appointmentMetrics: /AppointmentMetrics|Appointment_Metrics/i,
  cancellations:      /Cancellation/i,
  charting:           /Charting|Chart/i,
  leads:              /Lead|leads/i
};

const FILE_LABELS = {
  generalVisits:      'General Visit Report',
  appointmentMetrics: 'Appointment Metrics Report',
  cancellations:      'Cancellation Report',
  charting:           'Charting Report',
  leads:              'Total Leads Report'
};

let selectedFiles = {}; // key → File

function detectFileType(filename) {
  for (const [key, pattern] of Object.entries(FILE_PATTERNS)) {
    if (pattern.test(filename)) return key;
  }
  return null;
}

function renderFileList() {
  const list = document.getElementById('fileList');
  list.innerHTML = '';
  for (const [key, file] of Object.entries(selectedFiles)) {
    const label = FILE_LABELS[key] || 'Unknown';
    const matched = !!FILE_LABELS[key];
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = \`
      <div class="file-item-left">
        <div class="file-dot \${matched ? '' : 'unmatched'}"></div>
        <div>
          <div class="file-name">\${file.name}</div>
          <div class="file-type">\${matched ? '✓ ' + label : '⚠ Unrecognized — check filename'}</div>
        </div>
      </div>
      <button class="file-remove" onclick="removeFile('\${key}')" title="Remove">×</button>
    \`;
    list.appendChild(item);
  }
}

function removeFile(key) {
  delete selectedFiles[key];
  renderFileList();
}

function addFiles(files) {
  for (const file of files) {
    const type = detectFileType(file.name);
    const key = type || ('unknown_' + file.name);
    selectedFiles[key] = file;
  }
  renderFileList();
}

// Drop zone
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  addFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

async function submitMetrics() {
  const btn = document.getElementById('submitBtn');
  const status = document.getElementById('statusBar');

  if (Object.keys(selectedFiles).length === 0) {
    status.className = 'status-bar error';
    status.textContent = '❌ Please upload at least one report file before submitting.';
    return;
  }

  // Check if locked month requires PIN
  const lockWarning = document.getElementById('lockWarning');
  if (lockWarning.style.display !== 'none') {
    const pin = document.getElementById('overwritePin').value.trim();
    if (!pin) {
      status.className = 'status-bar error';
      status.textContent = '❌ This month is finalized. Enter the authorization PIN to overwrite.';
      return;
    }
    // PIN validated server-side — pass it along
  }

  btn.disabled = true;
  btn.textContent = 'Processing...';
  status.className = 'status-bar processing';
  status.textContent = '⏳ Uploading reports and updating Google Sheet — this may take 15–30 seconds...';

  const form = document.getElementById('metricsForm');
  const formData = new FormData(form);

  // Include PIN if present
  const pin = document.getElementById('overwritePin')?.value?.trim();
  if (pin) formData.append('overwritePin', pin);

  // Attach detected files under their correct field names
  for (const [key, file] of Object.entries(selectedFiles)) {
    if (FILE_LABELS[key]) {
      formData.append(key, file, file.name);
    }
  }

  try {
    const resp = await fetch('/metrics/submit', { method: 'POST', body: formData });
    const result = await resp.json();
    if (resp.ok && result.success) {
      status.className = 'status-bar success';
      status.textContent = '✅ Google Sheet updated successfully. ' + (result.summary || '');
      btn.textContent = 'Upload & Update Google Sheet';
      btn.disabled = false;
    } else {
      throw new Error(result.error || 'Unknown error');
    }
  } catch(err) {
    status.className = 'status-bar error';
    status.textContent = '❌ Error: ' + err.message;
    btn.textContent = 'Upload & Update Google Sheet';
    btn.disabled = false;
  }
}
</script>
</body>
</html>`);
});

// POST /metrics/submit — process files and write to Google Sheet
app.post('/metrics/submit', metricsUpload.fields([
  { name: 'generalVisits', maxCount: 1 },
  { name: 'appointmentMetrics', maxCount: 1 },
  { name: 'cancellations', maxCount: 1 },
  { name: 'charting', maxCount: 1 },
  { name: 'leads', maxCount: 1 }
]), async (req, res) => {
  try {
    const { month, year: yearStr, week: weekStr, overwritePin } = req.body;
    const year = parseInt(yearStr);
    const week = parseInt(weekStr);
    const files = req.files || {};

    // ── Overwrite guard ──────────────────────────────────────────
    const now = new Date();
    const MONTH_NAMES_SRV = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const curMonthIdx = now.getMonth();
    const curYear     = now.getFullYear();
    const submittedIdx = MONTH_NAMES_SRV.indexOf(month);

    const isCurrent    = (year === curYear && submittedIdx === curMonthIdx);
    const isPrior      = (year === curYear && submittedIdx === curMonthIdx - 1) ||
                         (year === curYear - 1 && submittedIdx === 11 && curMonthIdx === 0);
    const inGrace      = isPrior && now.getDate() <= 7;
    const isLocked     = !isCurrent && !inGrace;

    if (isLocked) {
      const CORRECT_PIN = '2365';
      if (!overwritePin || overwritePin.trim() !== CORRECT_PIN) {
        return res.status(403).json({
          error: `${month} ${year} is outside the allowed submission window and is considered finalized. A valid authorization PIN is required to overwrite this data.`
        });
      }
      console.log(`Overwrite authorized for ${month} ${year} — PIN accepted`);
    }
    // ────────────────────────────────────────────────────────────

    const updates = [];
    const summary = [];

    // ── 1. General Visit Report ──────────────────────────────
    if (files.generalVisits?.[0]) {
      const visitData = parseGeneralVisitReport(files.generalVisits[0].buffer);
      let clinicEvals = 0, clinicVisits = 0;

      for (const [pt, counts] of Object.entries(visitData)) {
        const tab = PT_TABS[pt];
        if (!tab) continue;
        const anchors = pt === 'Jordan McCormack' ? TABLE_ANCHORS.clinic : TABLE_ANCHORS.pt;

        // Total Evals — PT tab
        const evalCell = monthlyCell(TABLE_ANCHORS.pt.totalEvals, month, year);
        if (evalCell && pt !== 'Jordan McCormack') updates.push({ sheetName: tab, cell: evalCell, value: counts.evals });

        // Total Visits — PT tab
        const visitCell = monthlyCell(TABLE_ANCHORS.pt.totalVisits, month, year);
        if (visitCell && pt !== 'Jordan McCormack') updates.push({ sheetName: tab, cell: visitCell, value: counts.visits });

        // Jordan tab gets evals and visits too
        if (pt === 'Jordan McCormack') {
          const jEvalCell = monthlyCell(TABLE_ANCHORS.pt.totalEvals, month, year);
          const jVisitCell = monthlyCell(TABLE_ANCHORS.pt.totalVisits, month, year);
          if (jEvalCell) updates.push({ sheetName: PT_TABS['Jordan McCormack'], cell: jEvalCell, value: counts.evals });
          if (jVisitCell) updates.push({ sheetName: PT_TABS['Jordan McCormack'], cell: jVisitCell, value: counts.visits });
        }

        clinicEvals += counts.evals;
        clinicVisits += counts.visits;
      }

      // Clinic tab totals
      const clinicEvalCell = monthlyCell(TABLE_ANCHORS.clinic.totalEvals, month, year);
      const clinicVisitCell = monthlyCell(TABLE_ANCHORS.clinic.totalVisits, month, year);
      if (clinicEvalCell) updates.push({ sheetName: CLINIC_TAB, cell: clinicEvalCell, value: clinicEvals });
      if (clinicVisitCell) updates.push({ sheetName: CLINIC_TAB, cell: clinicVisitCell, value: clinicVisits });
      summary.push(`Visits parsed.`);
    }

    // ── 2. Cancellations ─────────────────────────────────────
    if (files.cancellations?.[0]) {
      const cancelData = parseCancellations(files.cancellations[0].buffer);
      let clinicOver24 = 0, clinicLate = 0;

      for (const [pt, counts] of Object.entries(cancelData)) {
        const tab = PT_TABS[pt];
        if (!tab) continue;

        const over24Cell = monthlyCell(TABLE_ANCHORS.pt.totalCancels24hr, month, year);
        const lateCell = monthlyCell(TABLE_ANCHORS.pt.totalLateCancels, month, year);
        if (over24Cell) updates.push({ sheetName: tab, cell: over24Cell, value: counts.over24 });
        if (lateCell) updates.push({ sheetName: tab, cell: lateCell, value: counts.lateCancelNoShow });

        clinicOver24 += counts.over24;
        clinicLate += counts.lateCancelNoShow;
      }

      const cOver24Cell = monthlyCell(TABLE_ANCHORS.clinic.totalCancels24hr, month, year);
      const cLateCell = monthlyCell(TABLE_ANCHORS.clinic.totalLateCancels, month, year);
      if (cOver24Cell) updates.push({ sheetName: CLINIC_TAB, cell: cOver24Cell, value: clinicOver24 });
      if (cLateCell) updates.push({ sheetName: CLINIC_TAB, cell: cLateCell, value: clinicLate });
      summary.push(`Cancellations parsed.`);
    }

    // ── 3. Charting Report (Open Charts) — weekly ────────────
    let chartRows = null;
    if (files.charting?.[0]) {
      const chartData = parseChartingReport(files.charting[0].buffer);
      chartRows = chartData.rows;
      let clinicCharts = 0;

      for (const [pt, count] of Object.entries(chartData.counts)) {
        const tab = PT_TABS[pt];
        if (!tab) continue;
        const cell = weeklyCell(TABLE_ANCHORS.pt.totalOpenCharts, month, week);
        if (cell) updates.push({ sheetName: tab, cell, value: count });
        clinicCharts += count;
      }

      const clinicChartCell = weeklyCell(TABLE_ANCHORS.clinic.totalOpenCharts, month, week);
      if (clinicChartCell) updates.push({ sheetName: CLINIC_TAB, cell: clinicChartCell, value: clinicCharts });
      summary.push(`Open charts parsed.`);
    }

    // ── 4. Leads PDF ─────────────────────────────────────────
    if (files.leads?.[0]) {
      const leadCount = await extractLeadsFromPdf(files.leads[0].buffer);
      const leadsCell = monthlyCell(TABLE_ANCHORS.clinic.totalLeads, month, year);
      if (leadsCell) updates.push({ sheetName: CLINIC_TAB, cell: leadsCell, value: leadCount });
      summary.push(`Leads: ${leadCount}.`);
    }

    // ── 5. Overdue Tasks (manual entry) — weekly ─────────────
    const taskMap = {
      'Chris Bostwick': parseInt(req.body.tasks_chris) || 0,
      'TJ Aquino':      parseInt(req.body.tasks_tj) || 0,
      'John Gan':       parseInt(req.body.tasks_john) || 0
    };
    let clinicTasks = 0;
    for (const [pt, count] of Object.entries(taskMap)) {
      const tab = PT_TABS[pt];
      const cell = weeklyCell(TABLE_ANCHORS.pt.totalOverdueTasks, month, week);
      if (cell) updates.push({ sheetName: tab, cell, value: count });
      clinicTasks += count;
    }
    const clinicTaskCell = weeklyCell(TABLE_ANCHORS.clinic.totalOverdueTasks, month, week);
    if (clinicTaskCell) updates.push({ sheetName: CLINIC_TAB, cell: clinicTaskCell, value: clinicTasks });

    // ── 6. Eval Conversions (from post-eval sheet) ────────────
    try {
      const conversionData = await getEvalConversions(month, year);
      let clinicConversions = 0;
      for (const [pt, count] of Object.entries(conversionData)) {
        const tab = PT_TABS[pt];
        if (!tab) continue;
        const cell = monthlyCell(TABLE_ANCHORS.pt.totalConversions, month, year);
        if (cell) updates.push({ sheetName: tab, cell, value: count });
        clinicConversions += count;
      }
      const clinicConvCell = monthlyCell(TABLE_ANCHORS.clinic.totalConversions, month, year);
      if (clinicConvCell) updates.push({ sheetName: CLINIC_TAB, cell: clinicConvCell, value: clinicConversions });
      summary.push(`Conversions: ${clinicConversions} total.`);
    } catch(convErr) {
      console.error('Failed to fetch eval conversions:', convErr.message);
    }

    // ── 7. Write all updates to Google Sheet ─────────────────
    if (updates.length > 0) {
      await writeSheetUpdates(updates);
    }

    // ── 7b. Save parsed metrics snapshot to /data for dashboard ──
    try {
      const latestMetrics = {
        month, year, week,
        updatedAt: new Date().toISOString(),
        visitData: files.generalVisits?.[0] ? parseGeneralVisitReport(files.generalVisits[0].buffer) : null,
        schedEfficiency: files.appointmentMetrics?.[0] ? parseAppointmentMetrics(files.appointmentMetrics[0].buffer) : null,
      };
      const metricsPath = require('path').join(require('fs').existsSync('/data') ? '/data' : '/tmp', 'latest-metrics.json');
      require('fs').writeFileSync(metricsPath, JSON.stringify(latestMetrics));
    } catch(e) { console.error('Failed to save latest-metrics.json:', e.message); }

    // ── 8. Send open charts emails to each PT ────────────────
    if (chartRows) {
      const PT_EMAIL_MAP = {
        'Chris Bostwick': 'chris@movementclinicpt.com',
        'TJ Aquino':      'tj@movementclinicpt.com',
        'John Gan':       'john@movementclinicpt.com'
      };
      const submissionDate = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

      for (const [pt, ptEmail] of Object.entries(PT_EMAIL_MAP)) {
        const charts = chartRows[pt] || [];
        try {
          await sendOpenChartsEmail(ptEmail, pt, charts, submissionDate);
          console.log(`Open charts email sent to ${ptEmail}: ${charts.length} charts`);
        } catch (emailErr) {
          console.error(`Failed to send open charts email to ${ptEmail}:`, emailErr.message);
        }
      }
    }

    res.json({
      success: true,
      updatesWritten: updates.length,
      summary: `${updates.length} cells updated. ${summary.join(' ')}`
    });

  } catch (err) {
    console.error('Metrics submit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

