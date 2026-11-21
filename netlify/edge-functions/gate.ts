// Access gate. Runs on every request, before static files, functions, and any cache.
import type { Config, Context } from '@netlify/edge-functions';
import { gate } from '../../server/gate.ts';

export default async (req: Request, context: Context): Promise<Response> => {
  const decision = await gate(req, {
    GATE_PASSWORD: Netlify.env.get('GATE_PASSWORD'),
    GATE_SIGNING_KEY: Netlify.env.get('GATE_SIGNING_KEY'),
    STATUS_CHECK_SECRET: Netlify.env.get('STATUS_CHECK_SECRET'),
    WORKER_SECRET: Netlify.env.get('WORKER_SECRET'),
  });
  if (decision.action === 'respond') return decision.response;
  return context.next();
};

export const config: Config = { path: '/*' };
