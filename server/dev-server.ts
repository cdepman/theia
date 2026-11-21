// Local development server: the access gate and the read API on one port, without the
// Netlify CLI. Vite proxies /api and /auth here (see vite.config.ts).
//
//   npm run dev        Vite + this server
//
// If GATE_PASSWORD and GATE_SIGNING_KEY are set in .env the gate behaves exactly as it
// does in production. If they are not, the gate is skipped, for local use only.

import { createServer } from 'node:http';
import { dbFromEnv } from '../pipeline/db';
import { gate } from './gate';
import { handleApi } from './routes';

const PORT = Number(process.env.THEIA_API_PORT ?? 8788);
const gateConfigured = Boolean(process.env.GATE_PASSWORD && process.env.GATE_SIGNING_KEY);

const server = createServer(async (nodeReq, nodeRes) => {
  const chunks: Buffer[] = [];
  for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
  const url = `http://${nodeReq.headers.host ?? `localhost:${PORT}`}${nodeReq.url ?? '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  const req = new Request(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks) });

  let res: Response;
  try {
    const decision = gateConfigured ? await gate(req, process.env) : { action: 'next' as const };
    if (decision.action === 'respond') res = decision.response;
    else {
      res = await handleApi(req, {
        db: dbFromEnv(),
        env: gateConfigured
          ? { GATE_SIGNING_KEY: process.env.GATE_SIGNING_KEY, STATUS_CHECK_SECRET: process.env.STATUS_CHECK_SECRET }
          : { THEIA_DEV_NO_AUTH: '1' },
      });
    }
  } catch (e) {
    res = new Response(JSON.stringify({ error: { code: 'not_configured', message: (e as Error).message } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  nodeRes.statusCode = res.status;
  res.headers.forEach((v, k) => nodeRes.setHeader(k, v));
  nodeRes.end(Buffer.from(await res.arrayBuffer()));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[theia] API on http://127.0.0.1:${PORT} (${gateConfigured ? 'gate enabled' : 'gate skipped: GATE_PASSWORD/GATE_SIGNING_KEY not set'})`);
});
