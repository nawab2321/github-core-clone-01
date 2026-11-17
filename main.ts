import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (!envUrl) {
  process.stderr.write('MAKEFUN_ENV_URL is required\n');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestUntil(url: string, init?: RequestInit, accept?: (response: Response) => boolean) {
  let delay = 100;
  for (;;) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
      if (accept?.(response)) return response;
    } catch {}
    await sleep(delay);
    delay = Math.min(delay * 2, 1_000);
  }
}

async function run() {
  const server = createApp();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind an ephemeral port');
  await requestUntil(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: address.port }),
  }, (response) => response.ok || response.status === 409);

  for (;;) {
    const response = await requestUntil(`${envUrl}/done`, undefined, (r) => r.ok);
    const state = await response.json();
    if (state.done === true) break;
    await sleep(250);
  }
  await new Promise((resolve) => server.close(resolve));
}

run().then(() => process.exit(0), (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
