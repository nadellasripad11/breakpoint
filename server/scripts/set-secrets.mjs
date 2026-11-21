// one command to give the hosted api a pair of credentials:
//   npm run secrets:notion        or        npm run secrets:google
// it asks you to paste each value (hidden) and stores it as a cloudflare worker secret. nothing is written to disk or git.
// add --check to see which of the two are already set, without changing anything:  npm run secrets:notion -- --check
import { spawnSync } from 'node:child_process';

const WRANGLER = ['--yes', 'wrangler@4.50.0'];
const sets = { notion: ['NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET'], google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] };
const which = process.argv[2];
if (!sets[which]) {
  console.log('usage: npm run secrets:notion   |   npm run secrets:google   (add -- --check to only look)');
  process.exit(1);
}

if (process.argv.includes('--check')) {
  const r = spawnSync('npx', [...WRANGLER, 'secret', 'list', '--format', 'json'], { encoding: 'utf8', shell: true });
  const out = `${r.stdout ?? ''}`;
  const start = out.indexOf('[');
  if (r.status !== 0 || start < 0) {
    console.log('Could not read the Worker secrets. Are you signed in to Cloudflare? Run: npx wrangler@4.50.0 login');
    console.log((r.stderr || out).slice(0, 400));
    process.exit(1);
  }
  const names = new Set(JSON.parse(out.slice(start, out.lastIndexOf(']') + 1)).map((s) => s.name));
  for (const name of sets[which]) console.log(`${names.has(name) ? 'SET    ' : 'MISSING'}  ${name}`);
  process.exit(sets[which].every((n) => names.has(n)) ? 0 : 2);
}

for (const name of sets[which]) {
  console.log(`\nPaste the value for ${name}, then press Enter (it stays hidden):`);
  const r = spawnSync('npx', [...WRANGLER, 'secret', 'put', name], { stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.log(`\nThat did not work (see the message above). Nothing else was changed. Run the same command again.`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\nDone: the ${which} credentials are set. No redeploy needed. Tell Claude "done" and it will check.`);
