// Command-line runner. The same worker code runs here, in the Netlify Background
// Function, and (as the fallback) in a scheduled CI job.
//
//   npm run check:connection   verify the Supabase secret key and schema
//   npm run registry:sync      load config/source-*.json into the database
//   npm run pipeline           one dispatcher tick plus one worker run
//   npm run status             print the data-status summary

import { readFileSync } from 'node:fs';
import { dbFromEnv } from '../db';
import { dispatchTick } from './dispatcher';
import { type Activation, buildRegistry, type CandidatePublisher } from './registry';
import { validateOrigins, type OriginConfig } from './signals';
import { originsWithoutCredentials } from '../providers/signals/providers';
import { runWorker } from './worker';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')) as T;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'run';
  const flags = new Set(process.argv.slice(3));
  const db = dbFromEnv();

  if (command === 'check') {
    const meta = await db.rpc<{ countries: { code: string; monitoredPublisherCount: number }[] }>('theia_meta');
    console.log('Connected. Schema is present.');
    for (const c of meta.countries) console.log(`  ${c.code}: ${c.monitoredPublisherCount} publishers enabled`);
    return;
  }

  if (command === 'sync-registry') {
    const candidates = readJson<{ publishers: CandidatePublisher[] }>('config/source-candidates.json');
    const activation = readJson<Activation>('config/source-activation.json');
    const result = await db.rpc('theia_sync_registry', { p_registry: buildRegistry(candidates, activation) });
    console.log('Registry synced:', JSON.stringify(result));
    if (activation.publisherAttributes) {
      const n = await db.rpc('theia_set_publisher_attributes', { p_attributes: activation.publisherAttributes });
      console.log(`Publisher attributes set: ${n}`);
    }
    const origins = validateOrigins(readJson<{ origins: OriginConfig[] }>('config/signal-sources.json'));
    console.log('Origins synced:', JSON.stringify(await db.rpc('theia_sync_origins', { p_config: origins })));
    const skipped = originsWithoutCredentials(process.env);
    if (skipped.length > 0) console.log(`Not collected until credentials are set: ${skipped.join(', ')}`);
    return;
  }

  if (command === 'status') {
    console.log(JSON.stringify(await db.rpc('theia_data_status'), null, 2));
    console.log(JSON.stringify(await db.rpc('theia_signal_status'), null, 2));
    return;
  }

  if (command === 'pause' || command === 'resume') {
    await db.rpc('theia_set_setting', { p_key: 'dispatch_paused', p_value: command === 'pause' });
    console.log(`Dispatch ${command === 'pause' ? 'paused' : 'resumed'}.`);
    return;
  }

  if (command === 'run') {
    const log = (message: string, detail?: Record<string, unknown>) =>
      console.log(`[theia] ${message}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
    const tick = await dispatchTick(db, async (status) => {
      await runWorker(db, { staleCountries: status.staleCountries, log });
    });
    log('dispatch tick', { ...tick });
    if (!tick.invoked && flags.has('--force')) {
      await runWorker(db, { staleCountries: ['US', 'GB', 'JP'], log });
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((e) => {
  console.error(`[theia] ${(e as Error).message}`);
  process.exit(1);
});
