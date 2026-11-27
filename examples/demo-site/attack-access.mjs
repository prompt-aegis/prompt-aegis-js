/** Loopback-only regression probe for access.paths / Express routing mismatches.
 * Run after pnpm build: node examples/demo-site/attack-access.mjs
 * Exit 1 means at least one unauthenticated request reached the private fixture.
 */
import express from 'express';
import { aegisExpress } from '@prompt-aegis/node';

const app = express();
let checks = 0;
app.use(
  aegisExpress({
    tarpit: { delayMs: 0 },
    access: {
      paths: ['/private/secret'],
      verify: () => {
        checks++;
        return false;
      },
    },
  }),
);
// Express defaults to case-insensitive routing and decodes route parameters.
app.get('/private/:name', (req, res) => {
  if (req.params.name.toLowerCase() !== 'secret') return res.sendStatus(404);
  res.send('PRIVATE_TEST_FIXTURE');
});
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  let bypasses = 0;
  for (const path of ['/private/secret', '/PRIVATE/secret', '/private/%73ecret']) {
    const before = checks;
    const response = await fetch(origin + path, {
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/130.0 Safari/537.36' },
      signal: AbortSignal.timeout(5000),
    });
    const leaked = (await response.text()).includes('PRIVATE_TEST_FIXTURE');
    const blocked = response.status === 403 && checks > before && !leaked;
    if (!blocked) bypasses++;
    console.log(
      JSON.stringify({
        path,
        status: response.status,
        verificationCalled: checks > before,
        privateFixtureReturned: leaked,
        blocked,
      }),
    );
  }
  console.log(`Access probes: ${3 - bypasses}/3 blocked; ${bypasses}/3 failed.`);
  process.exitCode = bypasses ? 1 : 0;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
