import express from 'express';
import { randomBytes } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --------------------------------------------------------------------------
// Environment
// --------------------------------------------------------------------------
const JN_BASE    = 'https://app.jobnimbus.com/api1';
const API_KEY    = process.env.JOBNIMBUS_API_KEY;
const MCP_SECRET = process.env.MCP_SECRET;

if (!API_KEY)    { console.error('ERROR: JOBNIMBUS_API_KEY not set'); process.exit(1); }
if (!MCP_SECRET) { console.error('ERROR: MCP_SECRET not set');         process.exit(1); }

// --------------------------------------------------------------------------
// CORS — allow Claude.ai / Cowork to reach this server
// --------------------------------------------------------------------------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function baseUrl(req: express.Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  return `${proto}://${req.headers.host}`;
}

// --------------------------------------------------------------------------
// OAuth 2.1 — minimal implementation for a private single-user server.
// Cowork discovers these endpoints and performs the authorization code + PKCE
// flow before it will connect to /mcp.
// --------------------------------------------------------------------------

// One-time auth codes: code → { redirect_uri, expiry }
const pendingCodes = new Map<string, { redirect_uri: string; expires: number }>();

// Protected resource metadata (tells Cowork which auth server to use)
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = baseUrl(req);
  res.json({
    resource:             `${base}/mcp`,
    authorization_servers: [base],
  });
});

// Authorization server metadata (tells Cowork where the auth endpoints are)
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = baseUrl(req);
  res.json({
    issuer:                                base,
    authorization_endpoint:               `${base}/authorize`,
    token_endpoint:                        `${base}/token`,
    response_types_supported:             ['code'],
    grant_types_supported:                ['authorization_code'],
    code_challenge_methods_supported:     ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

// Authorization endpoint — auto-approves and redirects back immediately.
// No login form needed for a private server.
app.get('/authorize', (req, res) => {
  const { redirect_uri, state } = req.query as Record<string, string>;
  if (!redirect_uri) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri required' });
  }
  const code = randomBytes(32).toString('hex');
  pendingCodes.set(code, { redirect_uri, expires: Date.now() + 60_000 }); // 60 s TTL
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// Token endpoint — exchanges the auth code for MCP_SECRET as the access token.
app.post('/token', (req, res) => {
  const { grant_type, code } = req.body as Record<string, string>;
  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  const pending = pendingCodes.get(code);
  if (!pending || Date.now() > pending.expires) {
    pendingCodes.delete(code);
    return res.status(400).json({ error: 'invalid_grant' });
  }
  pendingCodes.delete(code); // one-time use
  res.json({ access_token: MCP_SECRET, token_type: 'bearer', expires_in: 31_536_000 });
});

// --------------------------------------------------------------------------
// Bearer token middleware — validates every /mcp request
// --------------------------------------------------------------------------
function requireBearer(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.headers.authorization === `Bearer ${MCP_SECRET}`) return next();
  const base = baseUrl(req);
  res.set(
    'WWW-Authenticate',
    `Bearer realm="${base}", resource_metadata="${base}/.well-known/oauth-protected-resource"`
  );
  res.status(401).json({ error: 'unauthorized' });
}

// --------------------------------------------------------------------------
// JobNimbus API helper
// --------------------------------------------------------------------------
async function jn(path: string, params?: Record<string, string>) {
  const url = new URL(`${JN_BASE}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `token ${API_KEY}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`JobNimbus GET ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// --------------------------------------------------------------------------
// MCP tool definitions
// --------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'list_invoices',
    description:
      'List JobNimbus invoices including line items (items array). ' +
      'Optionally filter by status name or customer_id, or limit the count returned.',
    inputSchema: {
      type: 'object',
      properties: {
        size:        { type: 'number', description: 'Max invoices to return (default 50, max 100)' },
        status:      { type: 'string', description: 'Filter by status name e.g. "Draft", "Sent", "Paid"' },
        customer_id: { type: 'string', description: 'Filter by customer JNID' },
      },
    },
  },
  {
    name: 'get_invoice',
    description:
      'Get a single JobNimbus invoice by JNID. Returns full detail including ' +
      'all line items with product names, quantities, unit prices, and totals.',
    inputSchema: {
      type: 'object',
      required: ['jnid'],
      properties: {
        jnid: { type: 'string', description: 'The JobNimbus JNID of the invoice' },
      },
    },
  },
];

// --------------------------------------------------------------------------
// Tool handlers
// --------------------------------------------------------------------------
async function callTool(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case 'list_invoices': {
      const params: Record<string, string> = { size: String(Math.min(args.size ?? 50, 100)) };
      if (args.customer_id) params['customer'] = args.customer_id;
      const data = await jn('/v2/invoices', params);
      let invoices: any[] = data.results ?? data;
      if (args.status) {
        const q = args.status.toLowerCase();
        invoices = invoices.filter((inv: any) => inv.status_name?.toLowerCase().includes(q));
      }
      const summary = invoices.map((inv: any) => ({
        jnid:         inv.jnid,
        number:       inv.number,
        status:       inv.status_name,
        customer:     inv.customer,
        date_invoice: inv.date_invoice,
        date_due:     inv.date_due,
        subtotal:     inv.subtotal,
        tax:          inv.tax,
        total:        inv.total,
        due:          inv.due,
        items: (inv.items ?? []).map((item: any) => ({
          name:        item.name,
          description: item.description,
          quantity:    item.quantity,
          unit_price:  item.unit_price,
          total_price: item.total_price,
          product_id:  item.product_id,
        })),
      }));
      return JSON.stringify({ count: summary.length, invoices: summary }, null, 2);
    }
    case 'get_invoice': {
      if (!args.jnid) throw new Error('jnid is required');
      return JSON.stringify(await jn(`/v2/invoices/${args.jnid}`), null, 2);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --------------------------------------------------------------------------
// MCP server factory
// --------------------------------------------------------------------------
function createServer() {
  const server = new Server(
    { name: 'jobnimbus-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return { content: [{ type: 'text', text: await callTool(req.params.name, req.params.arguments ?? {}) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });
  return server;
}

// --------------------------------------------------------------------------
// MCP HTTP endpoint — Streamable HTTP transport (current MCP standard)
// --------------------------------------------------------------------------
async function handleMcp(req: express.Request, res: express.Response) {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

app.post('/mcp',   requireBearer, handleMcp);
app.get('/mcp',    requireBearer, handleMcp);
app.delete('/mcp', requireBearer, (_req, res) => res.status(200).end());

// --------------------------------------------------------------------------
// Health check
// --------------------------------------------------------------------------
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'jobnimbus-mcp', version: '1.0.0' })
);

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`JobNimbus MCP server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
