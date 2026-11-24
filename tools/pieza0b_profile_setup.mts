import { afterAll, beforeAll } from 'vitest';
import { Session } from 'node:inspector';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const output = process.env['PIEZA0B_PROFILE_OUTPUT'];
let session: Session | undefined;
beforeAll(async () => {
  if (output === undefined) return;
  session = new Session(); session.connect();
  await new Promise<void>((resolve, reject) => session?.post('Profiler.enable', (err) => err ? reject(err) : resolve()));
  await new Promise<void>((resolve, reject) => session?.post('Profiler.start', (err) => err ? reject(err) : resolve()));
});
afterAll(async () => {
  if (session === undefined || output === undefined) return;
  const result = await new Promise<unknown>((resolve, reject) => session?.post('Profiler.stop', (err, profile) => err ? reject(err) : resolve(profile)));
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'worker.cpuprofile'), JSON.stringify(result));
  session.disconnect();
});
