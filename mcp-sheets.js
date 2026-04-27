// ============================================================
// SHEETS MCP MODULE — Official @modelcontextprotocol/sdk
// ============================================================
// Stateless Streamable HTTP MCP server. No custom OAuth.
// Read-only Google Sheets access via shared service account.
//
// Replaces the previous custom OAuth 2.1 implementation —
// the SDK handles all protocol compliance automatically.
// ============================================================

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { google } = require('googleapis');

// ============================================================
// SHEETS LOGIC
// ============================================================

function parseAllowlist() {
  const raw = process.env.MCP_ALLOWED_SHEETS || '';
  if (!raw.trim()) return [];
  return raw.split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const idx = entry.indexOf(':');
      if (idx === -1) return null;
      const name = entry.slice(0, idx).trim();
      const id = entry.slice(idx + 1).trim();
      if (!name || !id) return null;
      return { name, id };
    })
    .filter(Boolean);
}

function resolveSheetId(nameOrId) {
  const allowlist = parseAllowlist();
  const byName = allowlist.find(s => s.name.toLowerCase() === nameOrId.toLowerCase());
  if (byName) return byName.id;
  if (allowlist.some(s => s.id === nameOrId)) return nameOrId;
  return null;
}

function getSheetsClient() {
  const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: saJson,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  return google.sheets({ version: 'v4', auth });
}

async function listSheets() {
  const allowlist = parseAllowlist();
  return {
    sheets: allowlist.map(s => ({ name: s.name, id: s.id })),
    count: allowlist.length
  };
}

async function getSheetMetadata({ sheet }) {
  const sheetId = resolveSheetId(sheet);
  if (!sheetId) throw new Error(`Sheet "${sheet}" is not in the allowlist.`);
  const client = getSheetsClient();
  const meta = await client.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'properties.title,sheets.properties(title,gridProperties)'
  });
  return {
    sheetId,
    title: meta.data.properties.title,
    tabs: meta.data.sheets.map(s => ({
      name: s.properties.title,
      rowCount: s.properties.gridProperties.rowCount,
      columnCount: s.properties.gridProperties.columnCount
    }))
  };
}

async function getHeaders({ sheet, tab }) {
  const sheetId = resolveSheetId(sheet);
  if (!sheetId) throw new Error(`Sheet "${sheet}" is not in the allowlist.`);
  const client = getSheetsClient();
  const result = await client.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'!1:1`
  });
  const headers = (result.data.values && result.data.values[0]) || [];
  return { sheetId, tab, headers, columnCount: headers.length };
}

async function readRange({ sheet, tab, range }) {
  const sheetId = resolveSheetId(sheet);
  if (!sheetId) throw new Error(`Sheet "${sheet}" is not in the allowlist.`);
  const client = getSheetsClient();
  const result = await client.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'!${range}`
  });
  return {
    sheetId, tab, range,
    values: result.data.values || [],
    rowCount: (result.data.values || []).length
  };
}

async function queryRows({ sheet, tab, columnFilters = {}, limit = 100 }) {
  const sheetId = resolveSheetId(sheet);
  if (!sheetId) throw new Error(`Sheet "${sheet}" is not in the allowlist.`);
  const client = getSheetsClient();
  const result = await client.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'`
  });
  const rows = result.data.values || [];
  if (rows.length === 0) return { sheetId, tab, headers: [], rows: [], totalMatched: 0 };
  const headers = rows[0];
  const dataRows = rows.slice(1);
  const colIndex = {};
  headers.forEach((h, i) => { colIndex[h] = i; });
  const filterEntries = Object.entries(columnFilters);
  const matches = filterEntries.length === 0
    ? dataRows
    : dataRows.filter(row => filterEntries.every(([col, expected]) => {
        const idx = colIndex[col];
        if (idx === undefined) return false;
        return (row[idx] || '').toString().toLowerCase().includes(expected.toString().toLowerCase());
      }));
  const limited = matches.slice(0, limit);
  const objects = limited.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });
  return {
    sheetId, tab, headers,
    rows: objects,
    totalMatched: matches.length,
    returned: limited.length,
    truncated: matches.length > limit
  };
}

// ============================================================
// MCP SERVER SETUP
// ============================================================

function createMcpServer() {
  const server = new McpServer({
    name: 'movement-clinic-sheets',
    version: '3.0.0'
  });

  // tool: list_sheets
  server.tool(
    'list_sheets',
    'List all Google Sheets the MCP has read access to. Returns friendly names and sheet IDs. Always call this first to discover what is available.',
    {},
    async () => {
      const result = await listSheets();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // tool: get_sheet_metadata
  server.tool(
    'get_sheet_metadata',
    'Get the structure of a specific Google Sheet — list all tabs (worksheets) within it with their row and column counts.',
    {
      sheet: z.string().describe('Friendly name or sheet ID')
    },
    async ({ sheet }) => {
      const result = await getSheetMetadata({ sheet });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // tool: get_headers
  server.tool(
    'get_headers',
    'Read the header row (row 1) of a specific tab. Use to understand column structure before querying data.',
    {
      sheet: z.string().describe('Friendly name or sheet ID'),
      tab: z.string().describe('Tab name')
    },
    async ({ sheet, tab }) => {
      const result = await getHeaders({ sheet, tab });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // tool: read_range
  server.tool(
    'read_range',
    'Read a specific range of cells from a tab in A1 notation (e.g. "A1:F50").',
    {
      sheet: z.string().describe('Friendly name or sheet ID'),
      tab: z.string().describe('Tab name'),
      range: z.string().describe('A1 notation range')
    },
    async ({ sheet, tab, range }) => {
      const result = await readRange({ sheet, tab, range });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // tool: query_rows
  server.tool(
    'query_rows',
    'Query rows from a tab with optional case-insensitive substring filters on column values.',
    {
      sheet: z.string().describe('Friendly name or sheet ID'),
      tab: z.string().describe('Tab name'),
      columnFilters: z.record(z.string()).optional().describe('Map of column header → substring to match'),
      limit: z.number().optional().default(100).describe('Max rows to return')
    },
    async ({ sheet, tab, columnFilters = {}, limit = 100 }) => {
      const result = await queryRows({ sheet, tab, columnFilters, limit });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  return server;
}

// ============================================================
// MOUNTING — Mounts the MCP endpoint on the Express app
// ============================================================

function mountMcp(app) {
  // Single endpoint handler — stateless mode.
  // Each request gets a fresh transport + server pair, which is the
  // simplest pattern and works for read-only servers like this one.
  const handleMcp = async (req, res) => {
    try {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined  // stateless mode
      });

      res.on('close', () => {
        transport.close();
        server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[MCP] Request error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  };

  app.post('/mcp', handleMcp);
  app.get('/mcp', handleMcp);
  app.delete('/mcp', handleMcp);

  console.log('[MCP] Sheets MCP mounted at /mcp (SDK-based, stateless)');
}

module.exports = {
  mountMcp
};
