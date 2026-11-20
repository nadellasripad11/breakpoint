// Runs the API test suites against the Cloudflare D1 store (through a node:sqlite stand-in for D1).
// Cross-platform replacement for `TEST_STORE=d1 node --test ...`.
import { spawnSync } from 'node:child_process';

const files = ['test/api.test.ts', 'test/oauth.test.ts', 'test/challenge.test.ts', 'test/calendar.test.ts'];
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, TEST_STORE: 'd1' } });
process.exit(r.status ?? 1);
