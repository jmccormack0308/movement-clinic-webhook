// ============================================================
// SHEETS MCP MODULE
// ============================================================
// Provides read-only Google Sheets access to Claude in conversation
// via Model Context Protocol (MCP) over streamable HTTP.
//
// Reuses the same TMC-Claude service account already used by the
// rest of the webhook server. Read-only by design — no write tools.
//
// Mounted at /mcp in index.js. Authenticated via MCP_AUTH_TOKEN env var.
// ============================================================

const { google } = require('googleapis');

// ---------- Allowlist parsing ----------
// MCP_ALLOWED_SHEETS env var format:
//   "Pipeline Tracker:1abc...xyz,Post-Eval:2def...uvw,Deals Board:3ghi...rst"
// Each entry is "Friendly Name:SheetID" comma-separated.
// Friendly names are what Claude sees; sheet IDs are what get queried.
function parseAllowlist() {
  const raw = process.env.MCP_ALLOWED_SHEETS || '';
  if (!raw.trim()) return [];

  return raw.split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const idx = entry.indexOf(':');
      if (idx === -1) {
        console.error(`[MCP] Malformed allowlist entry (missing colon): ${entry}`);
        return null;
      }
      const name = entry.slice(0, idx).trim();
      const id = entry.slice(idx + 1).trim();
      if (!name || !id) {
        console.error(`[MCP] Malformed allowlist entry (empty name or id): ${entry}`);
        return null;
      }
      return { name, id };
    })
    .filter(Boolean);
}

function isAllowed(sheetId) {
  return parseAllowlist().some(s => s.id === sheetId);
}

function resolveSheetId(nameOrId) {
  // Accept either friendly name or raw ID
  const allowlist = parseAllowlist();
  const byName = allowlist.find(s => s.name.toLowerCase() === nameOrId.toLowerCase());
  if (byName) return byName.id;
  if (allowlist.some(s => s.id === nameOrId)) return nameOrId;
  return null;
}

// ---------- Sheets client ----------
function getSheetsClient() {
  const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: saJson,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  return google.sheets({ version: 'v4', auth });
}

// ---------- Tool implementations ----------

async function listSheets() {
  const allowlist = parseAllowlist();
  if (allowlist.length === 0) {
    return {
      sheets: [],
      message: 'No sheets configured. Set MCP_ALLOWED_SHEETS env var with format "Name:ID,Name:ID".'
    };
  }
  return {
    sheets: allowlist.map(s => ({ name: s.name, id: s.id })),
    count: allowlist.length
  };
}

async function getSheetMetadata(args) {
  const { sheet } = args;
  const sheetId = resolveSheetId(sheet);
  if (!sheetId) {
    throw new Error(`Sheet "${sheet}" is not in the allowlist. Use list_sheets to see available sheets.`);
  }

  const client = getSheetsClient();
  const meta = await client.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'properties.title,sheets.properties(title,gridProperties)'
  });

  const tabs = meta.data.sheets.map(s => ({
    name: s.properties.title,
    rowCount: s.properties.gridProperties.rowCount,
    columnCount: s.properties.gridProperties.columnCount
  }));

  return {
    sheetId,
    title: meta.data.properties.title,
    tabs,
    tabCount: tabs.length
  };
}

async function getHeaders(args) {
  const { sheet, tab } = args;
  const sheetId = resolveSheetId(sheet);
  if (!sheetId) {
    throw new Error(`Sheet "${sheet}" is not in the allowlist. Use list_sheets to see available sheets.`);
  }

  const client = getSheetsClient();
  const range = `'${tab}'!1:1`;
  const result = await client.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range
  });

  const headers = (result.data.values && result.data.values[0]) || [];
  return {
    sheetId,
    tab,
    headers,
    columnCount: headers.length
  };
}

async function readRange(args) {
  const { sheet, tab, range } = args;
  const sheetId = resolveSheetId(sheet);
  if (!sheetId) {
    throw new Error(`Sheet "${sheet}" is not in the allowlist. Use list_sheets to see available sheets.`);
  }

  const client = getSheetsClient();
  const fullRange = `'${tab}'!${range}`;
  const result = await client.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: fullRange
  });

  return {
    sheetId,
    tab,
    range,
    values: result.data.values || [],
    rowCount: (result.data.values || []).length
  };
}

async function queryRows(args) {
  const { sheet, tab, columnFilters = {}, limit = 100 } = args;
  const sheetId = resolveSheetId(sheet);
  if (!sheetId) {
    throw new Error(`Sheet "${sheet}" is not in the allowlist. Use list_sheets to see available sheets.`);
  }

  const client = getSheetsClient();

  // Read entire tab (capped by Google API). For very large sheets this could be expensive,
  // but typical clinic sheets are well under a few thousand rows.
  const result = await client.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'`
  });

  const rows = result.data.values || [];
  if (rows.length === 0) {
    return { sheetId, tab, headers: [], rows: [], totalMatched: 0 };
  }

  const headers = rows[0];
  const dataRows = rows.slice(1);

  // Build column index map
  const colIndex = {};
  headers.forEach((h, i) => { colIndex[h] = i; });

  // Filter rows where every specified columnFilter matches (case-insensitive substring)
  const filterEntries = Object.entries(columnFilters);
  const matches = filterEntries.length === 0
    ? dataRows
    : dataRows.filter(row => {
        return filterEntries.every(([col, expected]) => {
          const idx = colIndex[col];
          if (idx === undefined) return false;
          const cell = (row[idx] || '').toString().toLowerCase();
          return cell.includes(expected.toString().toLowerCase());
        });
      });

  const limited = matches.slice(0, limit);

  // Return as objects for easier consumption
  const objects = limited.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });

  return {
    sheetId,
    tab,
    headers,
    rows: objects,
    totalMatched: matches.length,
    returned: limited.length,
    truncated: matches.length > limit
  };
}

// ---------- Tool definitions ----------
const TOOLS = [
  {
    name: 'list_sheets',
    description: 'List all Google Sheets the MCP has read access to. Returns friendly names and sheet IDs. Always call this first to discover what is available.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'get_sheet_metadata',
    description: 'Get the structure of a specific Google Sheet — list all tabs (worksheets) within it with their row and column counts. Use to discover what tabs exist before reading data.',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string', description: 'Friendly name (from list_sheets) or sheet ID' }
      },
      required: ['sheet'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'get_headers',
    description: 'Read the header row (row 1) of a specific tab. Use this to understand column structure before querying data.',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string', description: 'Friendly name (from list_sheets) or sheet ID' },
        tab: { type: 'string', description: 'Tab name (from get_sheet_metadata)' }
      },
      required: ['sheet', 'tab'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'read_range',
    description: 'Read a specific range of cells from a tab in A1 notation (e.g. "A1:F50", "B2:B100"). Use for targeted reads when you know exactly where the data is.',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string', description: 'Friendly name (from list_sheets) or sheet ID' },
        tab: { type: 'string', description: 'Tab name (from get_sheet_metadata)' },
        range: { type: 'string', description: 'A1 notation range, e.g. "A1:F50"' }
      },
      required: ['sheet', 'tab', 'range'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'query_rows',
    description: 'Query rows from a tab with optional case-insensitive substring filters on column values. Returns matching rows as objects keyed by column header. Use for "find rows where column X contains Y" type questions.',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string', description: 'Friendly name (from list_sheets) or sheet ID' },
        tab: { type: 'string', description: 'Tab name (from get_sheet_metadata)' },
        columnFilters: {
          type: 'object',
          description: 'Map of column header → substring to match. Example: {"Outcome": "EVAL_SCHEDULED"}. Empty object returns all rows.',
          additionalProperties: { type: 'string' }
        },
        limit: { type: 'number', description: 'Max rows to return (default 100)', default: 100 }
      },
      required: ['sheet', 'tab'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }
];

// ---------- Tool dispatcher ----------
async function callTool(name, args) {
  switch (name) {
    case 'list_sheets':       return await listSheets();
    case 'get_sheet_metadata': return await getSheetMetadata(args);
    case 'get_headers':        return await getHeaders(args);
    case 'read_range':         return await readRange(args);
    case 'query_rows':         return await queryRows(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------- HTTP handler (streamable HTTP transport, stateless JSON) ----------
// Implements MCP JSON-RPC 2.0 over HTTP POST. Each request is independent.
async function handleMcpRequest(req, res) {
  // Auth check
  const expectedToken = process.env.MCP_AUTH_TOKEN;
  if (!expectedToken) {
    return res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'MCP_AUTH_TOKEN not configured on server' },
      id: null
    });
  }

  const authHeader = req.headers.authorization || '';
  const providedToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  if (providedToken !== expectedToken) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null
    });
  }

  const { jsonrpc, method, params, id } = req.body || {};

  if (jsonrpc !== '2.0') {
    return res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
      id: id || null
    });
  }

  try {
    let result;

    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'movement-clinic-sheets',
            version: '1.0.0'
          }
        };
        break;

      case 'tools/list':
        result = { tools: TOOLS };
        break;

      case 'tools/call': {
        const { name, arguments: toolArgs } = params || {};
        if (!name) throw new Error('Missing tool name');

        const toolResult = await callTool(name, toolArgs || {});
        result = {
          content: [
            { type: 'text', text: JSON.stringify(toolResult, null, 2) }
          ],
          structuredContent: toolResult
        };
        break;
      }

      case 'notifications/initialized':
        // Notification, no response needed but we still return 200
        return res.status(200).end();

      case 'ping':
        result = {};
        break;

      default:
        return res.status(200).json({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method not found: ${method}` },
          id: id || null
        });
    }

    return res.status(200).json({ jsonrpc: '2.0', result, id: id || null });

  } catch (err) {
    console.error(`[MCP] Error handling ${method}:`, err.message);
    return res.status(200).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: err.message || 'Internal error',
        data: err.stack ? { stack: err.stack.split('\n').slice(0, 5).join('\n') } : undefined
      },
      id: id || null
    });
  }
}

module.exports = {
  handleMcpRequest,
  // Exported for testing / debugging
  TOOLS,
  callTool,
  parseAllowlist
};
