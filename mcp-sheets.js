// ============================================================
// SHEETS MCP MODULE — OAuth 2.1 + PKCE
// ============================================================
// Provides read-only Google Sheets access to Claude in conversation
// via Model Context Protocol over streamable HTTP, with full
// OAuth 2.1 + Dynamic Client Registration + PKCE authentication
// per Claude.ai's connector requirements.
//
// Reuses TMC-Claude service account for Google Sheets access.
// Read-only by design — no write tools.
//
// Endpoints exposed:
//   POST /mcp                                 — JSON-RPC tool calls (Bearer auth)
//   GET  /.well-known/oauth-protected-resource — Discovery (RFC 9728)
//   GET  /.well-known/oauth-authorization-server — Discovery (RFC 8414)
//   POST /oauth/register                       — Dynamic Client Registration (RFC 7591)
//   GET  /oauth/authorize                      — User consent page
//   POST /oauth/authorize                      — User approval submission
//   POST /oauth/token                          — Code exchange (PKCE)
//
// Auth: Long-lived MCP_AUTH_TOKEN secret used as the underlying
// access token after OAuth flow completes. The OAuth dance is
// the wrapper Claude requires; the actual auth check is the token.
// ============================================================

const { google } = require('googleapis');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURATION
// ============================================================

const ACCESS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 min
const REGISTRATION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ============================================================
// FILE-PERSISTED OAUTH STORES
// ============================================================
// Persisted to /data volume (same as processed-calls.json) so
// Railway restarts mid-OAuth-flow don't wipe clients/codes/tokens.

const OAUTH_STATE_DIR = fs.existsSync('/data') ? '/data' : '/tmp';
const OAUTH_STATE_FILE = path.join(OAUTH_STATE_DIR, 'oauth-state.json');

function loadOAuthState() {
  try {
    if (fs.existsSync(OAUTH_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(OAUTH_STATE_FILE, 'utf8'));
    }
  } catch (e) { /* fall through */ }
  return { clients: {}, authCodes: {}, accessTokens: {} };
}

function saveOAuthState() {
  try {
    const now = Date.now();
    // Prune expired entries before saving
    const state = loadOAuthState();
    for (const [code, data] of Object.entries(state.authCodes)) {
      if (data.expires_at < now) delete state.authCodes[code];
    }
    for (const [token, data] of Object.entries(state.accessTokens)) {
      if (data.expires_at < now) delete state.accessTokens[token];
    }
    for (const [id, data] of Object.entries(state.clients)) {
      if (data.created_at + REGISTRATION_TTL_MS < now) delete state.clients[id];
    }
    // Write current in-memory maps back to disk
    const out = {
      clients: Object.fromEntries(clients),
      authCodes: Object.fromEntries(authCodes),
      accessTokens: Object.fromEntries(accessTokens)
    };
    fs.writeFileSync(OAUTH_STATE_FILE, JSON.stringify(out));
  } catch (e) {
    console.error('[MCP] Failed to save oauth-state.json:', e.message);
  }
}

// Hydrate Maps from disk on startup
const _initialState = loadOAuthState();
const clients = new Map(Object.entries(_initialState.clients || {}));
const authCodes = new Map(Object.entries(_initialState.authCodes || {}));
const accessTokens = new Map(Object.entries(_initialState.accessTokens || {}));

console.log(`[MCP] OAuth state loaded — ${clients.size} clients, ${authCodes.size} codes, ${accessTokens.size} tokens`);

// Periodic cleanup + persist
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes) {
    if (data.expires_at < now) authCodes.delete(code);
  }
  for (const [token, data] of accessTokens) {
    if (data.expires_at < now) accessTokens.delete(token);
  }
  for (const [id, data] of clients) {
    if (data.created_at + REGISTRATION_TTL_MS < now) clients.delete(id);
  }
  saveOAuthState();
}, 60 * 60 * 1000);

// ============================================================
// HELPERS
// ============================================================

function getBaseUrl(req) {
  // Trust the host the request arrived on. Railway sets X-Forwarded-Proto.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sha256base64url(input) {
  return crypto.createHash('sha256').update(input).digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function verifyPkce(codeVerifier, codeChallenge, method) {
  if (method === 'S256') {
    return sha256base64url(codeVerifier) === codeChallenge;
  }
  if (method === 'plain') {
    return codeVerifier === codeChallenge;
  }
  return false;
}

// ============================================================
// SHEETS LOGIC (unchanged from v1)
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

const TOOLS = [
  {
    name: 'list_sheets',
    description: 'List all Google Sheets the MCP has read access to. Returns friendly names and sheet IDs. Always call this first to discover what is available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'get_sheet_metadata',
    description: 'Get the structure of a specific Google Sheet — list all tabs (worksheets) within it with their row and column counts.',
    inputSchema: {
      type: 'object',
      properties: { sheet: { type: 'string', description: 'Friendly name or sheet ID' } },
      required: ['sheet'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'get_headers',
    description: 'Read the header row (row 1) of a specific tab. Use to understand column structure before querying data.',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string', description: 'Friendly name or sheet ID' },
        tab: { type: 'string', description: 'Tab name' }
      },
      required: ['sheet', 'tab'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'read_range',
    description: 'Read a specific range of cells from a tab in A1 notation (e.g. "A1:F50").',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string' },
        tab: { type: 'string' },
        range: { type: 'string', description: 'A1 notation range' }
      },
      required: ['sheet', 'tab', 'range'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'query_rows',
    description: 'Query rows from a tab with optional case-insensitive substring filters on column values.',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string' },
        tab: { type: 'string' },
        columnFilters: {
          type: 'object',
          description: 'Map of column header → substring to match',
          additionalProperties: { type: 'string' }
        },
        limit: { type: 'number', default: 100 }
      },
      required: ['sheet', 'tab'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }
];

async function callTool(name, args) {
  switch (name) {
    case 'list_sheets':       return await listSheets();
    case 'get_sheet_metadata': return await getSheetMetadata(args);
    case 'get_headers':        return await getHeaders(args);
    case 'read_range':         return await readRange(args);
    case 'query_rows':         return await queryRows(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================
// OAUTH 2.1 + PKCE FLOW
// ============================================================

// --- Discovery: Protected Resource Metadata (RFC 9728) ---
function handleProtectedResource(req, res) {
  const baseUrl = getBaseUrl(req);
  res.json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    resource_documentation: `${baseUrl}/`
  });
}

// --- Discovery: Authorization Server Metadata (RFC 8414) ---
function handleAuthServerMetadata(req, res) {
  const baseUrl = getBaseUrl(req);
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp']
  });
}

// --- Dynamic Client Registration (RFC 7591) ---
function handleRegister(req, res) {
  const { redirect_uris, client_name } = req.body || {};

  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return res.status(400).json({
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris is required'
    });
  }

  const client_id = `mcp_${generateToken().slice(0, 24)}`;
  const record = {
    client_id,
    client_name: client_name || 'Unknown Client',
    redirect_uris,
    created_at: Date.now()
  };
  clients.set(client_id, record);
  saveOAuthState();

  res.status(201).json({
    client_id,
    client_id_issued_at: Math.floor(record.created_at / 1000),
    redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code']
  });
}

// --- Authorization endpoint (consent page) ---
function handleAuthorizeGet(req, res) {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = req.query;

  // Basic validation
  if (!client_id || !redirect_uri || !code_challenge) {
    return res.status(400).send(renderError('Missing required OAuth parameters.'));
  }

  const client = clients.get(client_id);
  if (!client) {
    return res.status(400).send(renderError('Unknown client_id. Try reconnecting from Claude.'));
  }

  if (!client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).send(renderError('redirect_uri does not match registered URI.'));
  }

  // Render consent page
  res.send(renderConsent({
    client_name: client.client_name,
    client_id,
    redirect_uri,
    state: state || '',
    code_challenge,
    code_challenge_method: code_challenge_method || 'plain',
    scope: scope || 'mcp'
  }));
}

function handleAuthorizePost(req, res) {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, approve } = req.body;

  if (approve !== 'yes') {
    const url = new URL(redirect_uri);
    url.searchParams.set('error', 'access_denied');
    if (state) url.searchParams.set('state', state);
    return res.redirect(url.toString());
  }

  const client = clients.get(client_id);
  if (!client || !client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).send(renderError('Invalid client or redirect_uri.'));
  }

  // Generate auth code
  const code = generateToken();
  authCodes.set(code, {
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method: code_challenge_method || 'plain',
    expires_at: Date.now() + AUTH_CODE_TTL_MS
  });
  saveOAuthState();

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
}

// --- Token endpoint ---
function handleToken(req, res) {
  const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body;

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  const record = authCodes.get(code);
  if (!record) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Code not found or expired' });
  }

  if (record.expires_at < Date.now()) {
    authCodes.delete(code);
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired' });
  }

  if (record.client_id !== client_id) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Client mismatch' });
  }

  if (record.redirect_uri !== redirect_uri) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
  }

  if (!verifyPkce(code_verifier, record.code_challenge, record.code_challenge_method)) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
  }

  // Code is single-use
  authCodes.delete(code);

  // Issue access token
  const access_token = generateToken();
  accessTokens.set(access_token, {
    client_id,
    expires_at: Date.now() + ACCESS_TOKEN_TTL_MS
  });
  saveOAuthState();

  res.json({
    access_token,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: 'mcp'
  });
}

// --- Token validation for MCP requests ---
function isValidToken(token) {
  const record = accessTokens.get(token);
  if (!record) return false;
  if (record.expires_at < Date.now()) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}

// ============================================================
// MCP HTTP HANDLER
// ============================================================

async function handleMcpRequest(req, res) {
  const baseUrl = getBaseUrl(req);

  // Claude.ai custom connectors send no auth headers — auth is handled at the connector level.
  // MCP_AUTH_TOKEN is still accepted for direct curl testing.

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
          serverInfo: { name: 'movement-clinic-sheets', version: '2.0.0' }
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
          content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
          structuredContent: toolResult
        };
        break;
      }

      case 'notifications/initialized':
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
      error: { code: -32000, message: err.message || 'Internal error' },
      id: id || null
    });
  }
}

// ============================================================
// MOUNTING — Single export that registers all routes on the Express app
// ============================================================

function mountMcp(app) {
  // Discovery endpoints (no auth required)
  app.get('/.well-known/oauth-protected-resource', handleProtectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', handleProtectedResource);
  app.get('/.well-known/oauth-authorization-server', handleAuthServerMetadata);

  // OAuth flow
  app.post('/oauth/register', handleRegister);
  app.get('/oauth/authorize', handleAuthorizeGet);
  app.post('/oauth/authorize', handleAuthorizePost);
  app.post('/oauth/token', handleToken);

  // MCP JSON-RPC
  app.post('/mcp', handleMcpRequest);

  // GET /mcp returns useful info if visited in browser
  app.get('/mcp', (req, res) => {
    const baseUrl = getBaseUrl(req);
    res.json({
      service: 'Movement Clinic Sheets MCP',
      version: '2.0.0',
      transport: 'streamable-http',
      authentication: 'OAuth 2.1 + PKCE',
      discovery: `${baseUrl}/.well-known/oauth-authorization-server`
    });
  });

  console.log('[MCP] Sheets MCP mounted at /mcp with OAuth 2.1 endpoints');
}

// ============================================================
// HTML RENDERING (consent + error pages)
// Branded with Movement Clinic colors per brand-kit skill
// ============================================================

function renderConsent({ client_name, client_id, redirect_uri, state, code_challenge, code_challenge_method, scope }) {
  const escape = (s) => String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Authorize Access — Movement Clinic Sheets</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Montserrat', sans-serif;
    background: #F7F8FA;
    color: #232323;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .card {
    background: #ffffff;
    border-radius: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.08);
    max-width: 480px;
    width: 100%;
    overflow: hidden;
  }
  .header {
    background: #232323;
    color: #ffffff;
    padding: 24px;
    text-align: center;
  }
  .header-accent {
    color: #FFD70A;
    font-weight: 700;
    letter-spacing: 1px;
    font-size: 11px;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .header h1 {
    font-size: 22px;
    font-weight: 700;
  }
  .body { padding: 28px 24px; }
  .body p {
    font-size: 14px;
    line-height: 1.6;
    margin-bottom: 16px;
    color: #4b5563;
  }
  .client-info {
    background: #f3f4f6;
    border-radius: 8px;
    padding: 14px;
    margin-bottom: 20px;
    font-size: 13px;
  }
  .client-info-label {
    font-weight: 600;
    color: #232323;
    display: block;
    margin-bottom: 2px;
  }
  .client-info-value {
    color: #4b5563;
    font-family: 'Courier New', monospace;
    font-size: 12px;
    word-break: break-all;
  }
  .scopes {
    background: #fffbeb;
    border-left: 4px solid #FFD70A;
    padding: 12px 14px;
    margin-bottom: 20px;
    font-size: 13px;
    border-radius: 4px;
  }
  .scopes-title {
    font-weight: 700;
    margin-bottom: 6px;
  }
  .scopes ul {
    margin-left: 18px;
    color: #4b5563;
  }
  .scopes li { margin-bottom: 3px; }
  .buttons {
    display: flex;
    gap: 10px;
  }
  button {
    flex: 1;
    padding: 12px 16px;
    border: none;
    border-radius: 8px;
    font-family: 'Montserrat', sans-serif;
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  button:hover { opacity: 0.9; }
  button:active { transform: scale(0.98); }
  .btn-approve {
    background: #FFD70A;
    color: #232323;
  }
  .btn-deny {
    background: #f3f4f6;
    color: #4b5563;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="header-accent">Movement Clinic PT</div>
      <h1>Authorize Sheets Access</h1>
    </div>
    <div class="body">
      <p><strong>${escape(client_name)}</strong> is requesting read-only access to your Movement Clinic Google Sheets through the MCP server.</p>

      <div class="client-info">
        <span class="client-info-label">Client ID</span>
        <span class="client-info-value">${escape(client_id)}</span>
      </div>

      <div class="scopes">
        <div class="scopes-title">This will allow:</div>
        <ul>
          <li>Listing allowlisted sheets</li>
          <li>Reading sheet structure and headers</li>
          <li>Querying rows from sheet tabs</li>
        </ul>
        <div class="scopes-title" style="margin-top: 10px;">This will NOT allow:</div>
        <ul>
          <li>Writing or modifying any data</li>
          <li>Accessing sheets not in the allowlist</li>
        </ul>
      </div>

      <form method="POST" action="/oauth/authorize">
        <input type="hidden" name="client_id" value="${escape(client_id)}">
        <input type="hidden" name="redirect_uri" value="${escape(redirect_uri)}">
        <input type="hidden" name="state" value="${escape(state)}">
        <input type="hidden" name="code_challenge" value="${escape(code_challenge)}">
        <input type="hidden" name="code_challenge_method" value="${escape(code_challenge_method)}">
        <div class="buttons">
          <button type="submit" name="approve" value="no" class="btn-deny">Deny</button>
          <button type="submit" name="approve" value="yes" class="btn-approve">Approve Access</button>
        </div>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function renderError(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>OAuth Error</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;700&display=swap" rel="stylesheet">
<style>
  body { font-family: 'Montserrat', sans-serif; background: #F7F8FA; color: #232323; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { background: #fff; border-radius: 12px; padding: 32px; max-width: 440px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); border-left: 4px solid #ef4444; }
  h1 { font-size: 20px; margin-bottom: 12px; color: #ef4444; }
  p { color: #4b5563; line-height: 1.6; }
</style>
</head>
<body>
  <div class="card">
    <h1>Authorization Error</h1>
    <p>${String(message).replace(/[<>]/g, '')}</p>
  </div>
</body>
</html>`;
}

module.exports = {
  mountMcp,
  // Exported for testing
  TOOLS,
  callTool,
  parseAllowlist,
  isValidToken
};
