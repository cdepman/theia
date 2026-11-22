// Capture public attention lists locally without database access or paid APIs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { validateOrigins, type OriginConfig } from './signals';
import { signalProviders } from '../providers/signals/providers';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { output: { type: 'string' }, origins: { type: 'string' } } });
  const config = validateOrigins(JSON.parse(readFileSync('config/signal-sources.json', 'utf8')) as { origins: OriginConfig[] });
  const requested = values.origins?.split(',').map((key) => key.trim());
  for (const key of requested ?? []) {
    if (!signalProviders[key]) throw new Error(`Unknown attention origin: ${key}`);
    if (signalProviders[key]!.requiresEnv?.length) throw new Error(`This probe supports only sources without credentials: ${key}`);
  }
  const origins = config.origins.filter((origin) => origin.key !== 'press' && origin.enabled !== false
    && !signalProviders[origin.key]!.requiresEnv?.length && (!requested || requested.includes(origin.key)));
  const observedAt = new Date().toISOString();
  const output = values.output ?? `scratch/signals-${observedAt.replace(/[:.]/g, '-')}.json`;
  const results: Record<string, unknown>[] = [];
  let next = 0, failures = 0;
  await Promise.all(Array.from({ length: Math.min(4, origins.length) }, async () => {
    for (let i = next++; i < origins.length; i = next++) {
      const origin = origins[i]!;
      for (const scope of origin.scopes ?? []) {
        const sourceKey = `${origin.key}:${scope.scope}`;
        const metadata = { sourceKey, origin: origin.key, scope: scope.scope, language: scope.language ?? null,
          country: scope.country ?? null, viewCountries: scope.viewCountries, observedAt: new Date().toISOString() };
        try {
          const result = await signalProviders[origin.key]!.run({ now: new Date(metadata.observedAt), env: {}, fetchImpl: fetch,
            source: { sourceKey, originKey: origin.key, scopeKey: scope.scope, language: scope.language ?? null,
              country: scope.country ?? null, params: scope.params ?? {}, cadenceSeconds: origin.cadenceSeconds ?? 10800,
              checkpoint: {}, seeds: [], leaseToken: 'local-probe', lastSuccessAt: null } });
          if (!result.items.length && !result.allowEmpty) throw new Error('The source returned no entries');
          results.push({ ...metadata, status: 'success', ...result });
          console.log(`${sourceKey}: ${result.items.length} items`);
        } catch (error) {
          failures++;
          results.push({ ...metadata, status: 'error', error: (error as Error).message, items: [] });
          console.log(`${sourceKey}: ${(error as Error).message}`);
        }
      }
    }
  }));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, observedAt, origins, results }, null, 2) + '\n', { flag: 'wx' });
  console.log(`SAVED ${output}; ${results.length - failures}/${results.length} sources succeeded; no paid APIs called`);
  if (failures) process.exitCode = 1;
}

main().catch((error: Error) => { console.error(`[signals:probe] ${error.message}`); process.exitCode = 1; });
