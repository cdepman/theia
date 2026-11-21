import { createClient } from '@supabase/supabase-js';

// Every database interaction is one call to a `public.theia_*` function, which runs
// as a single transaction. Keeping the surface this narrow lets the same pipeline
// code run against hosted Supabase and against an in-process Postgres in tests.
export interface Db {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>;
}

export class DbError extends Error {
  constructor(
    message: string,
    readonly fn: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DbError';
  }
}

export function createSupabaseDb(url: string, secretKey: string): Db {
  const client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      const { data, error } = await client.rpc(fn, args);
      if (error) {
        throw new DbError(`${fn} failed: ${error.message}`, fn, error.code);
      }
      return data as T;
    },
  };
}

export function dbFromEnv(env: Record<string, string | undefined> = process.env): Db {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set (server-side only).');
  }
  if (!key.startsWith('sb_secret_') && !key.startsWith('eyJ')) {
    throw new Error('SUPABASE_SECRET_KEY does not look like a Supabase secret key (expected sb_secret_...).');
  }
  return createSupabaseDb(url, key);
}
