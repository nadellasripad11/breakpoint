// One command to give the hosted API a pair of credentials: npm run secrets:notion   or   npm run secrets:google
// It asks you to paste each value (hidden) and stores it as a Cloudflare Worker secret. Nothing is written to disk or git.
import { spawnSync } from 'node:child_process';

const sets = { notion: ['NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET'], google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] };
const which = process.argv[2];
if (!sets[which]) {
  console.log('usage: npm run secrets:notion   |   npm run secrets:google');
  process.exit(1);
}
for (const name of sets[which]) {
  console.log(`\nPaste the value for ${name}, then press Enter (it stays hidden):`);
  const r = spawnSync('npx', ['--yes', 'wrangler@4.50.0', 'secret', 'put', name], { stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log(`\nDone: the ${which} credentials are set. No redeploy needed. Tell Claude "done" and it will check.`);
