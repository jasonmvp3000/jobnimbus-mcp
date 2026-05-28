import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

const JN_BASE = 'https://app.jobnimbus.com/api1';
const API_KEY = process.env.JOBNIMBUS_API_KEY;

if (!API_KEY) {
  console.error('ERROR: JOBNIMBUS_API_KEY environment variable is not set.');
  process.exit(1);
}

// --------------------------------------------------------------------------
// JobNimbus API helper
// --------------------------------------------------------------------------
async function jn(path: string, params?: Record<string, string>) {
  const url = new URL(`${JN_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `token ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JobNimbus API GET ${path} failed (${res.status}): ${text}`);
  }

  return res.json();
}

// --------------------------------------------------------------------------
// Tool definitions
// --------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'list_invoices',
    description:
      'List JobNimbus invoices. Returns invoice headers including number, customer, ' +
      'status, total, and line items (items array). ' +
      'Optionally filter by status name or limit the number of results.',
    inputSchema: {
      type: 'object',
      properties: {
        size: {
          type: 'number',
          description: 'Maximum number of invoices to return (default: 50, max: 100)',
        },
        status: {
          type: 'string',
          description:
            'Filter by status name, e.g. "Draft", "Sent", "Paid". Case-insensitive.',
        },
        customer_id: {
          type: 'string',
          description: 'Filter by customer JNID to get invoices for one customer only.',
        },
      },
    },
  },
  {
    name: 'get_invoice',
    description:
      'Get a single JobNimbus invoice by its JNID. Returns full detail including ' +
      'all line items with product names, quantities, unit prices, and totals. ' +
      'Use this after list_invoices to get the complete line-item breakdown for a specific invoice.',
    inputSchema: {
      type: 'object',
      required: ['jnid'],
      properties: {
        jnid: {
          type: 'string',
          description: 'The JobNimbus ID (jnid) of the invoice.',
        },
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
      const params: Record<string, string> = {
        size: String(Math.min(args.size ?? 50, 100)),
      };

      if (args.customer_id) {
        params['customer'] = args.customer_id;
      }

      const data = await jn('/v2/invoices', params);

      // Apply optional status filter client-side (JN API doesn't support it as a query param)
      let invoices: any[] = data.results ?? data;
      if (args.status) {
        const q = args.status.toLowerCase();
        invoices = invoices.filter(
          (inv: any) => inv.status_name?.toLowerCase().includes(q)
        );
      }

      // Return a concise summary for each invoice to keep the response manageable.
      // Each entry includes the fields Claude needs to match against Katana.
      const summary = invoices.map((inv: any) => ({
        jnid: inv.jnid,
        number: inv.number,
        status: inv.status_name,
        customer: inv.customer,
        date_invoice: inv.date_invoice,
        date_due: inv.date_due,
        subtotal: inv.subtotal,
        tax: inv.tax,
        total: inv.total,
        total_paid: inv.total_paid,
        due: inv.due,
        // Include items inline so a single list_invoices call is often enough
        items: (inv.items ?? []).map((item: any) => ({
          name: item.name,
          description: item.description,
          quantity: item.quantity,
          unit_cost: item.unit_cost,
          unit_price: item.unit_price,
          total_price: item.total_price,
          product_id: item.product_id,
        })),
      }));

      return JSON.stringify(
        { count: summary.length, invoices: summary },
        null,
        2
      );
    }

    case 'get_invoice': {
      if (!args.jnid) throw new Error('jnid is required');

      const inv = await jn(`/v2/invoices/${args.jnid}`);

      // Return full detail including raw items array for precise line-item mapping
      return JSON.stringify(inv, null, 2);
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
      const result = await callTool(req.params.name, req.params.arguments ?? {});
      return { content: [{ type: 'text', text: result }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// --------------------------------------------------------------------------
// HTTP / SSE transport
// --------------------------------------------------------------------------
const transports: Record<string, SSEServerTransport> = {};

app.get('/sse', async (_req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;

  res.on('close', () => {
    delete transports[transport.sessionId];
  });

  const server = createServer();
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];

  if (!transport) {
    return res.status(404).json({ error: 'Session not found. Connect to /sse first.' });
  }

  await transport.handlePostMessage(req, res);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'jobnimbus-mcp', version: '1.0.0' });
});

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`JobNimbus MCP server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`SSE:    http://localhost:${PORT}/sse`);
});
