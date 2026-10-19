// Run the server and expose it publicly via a free Cloudflare quick tunnel.
//   npm run share
// The tunnel URL changes every run; open /qr through it to get a matching QR code.
import { spawn, spawnSync } from 'node:child_process';

try {
  process.loadEnvFile('.env');
} catch {}

const PORT = process.env.PORT || '3000';
const token = process.env.ADMIN_TOKEN;
if (!token || token === 'change-me') {
  console.error(
    'Refusing to go public with the default admin token.\n' +
      'Set ADMIN_TOKEN to something secret in .env (cp .env.example .env), then re-run `npm run share`.',
  );
  process.exit(1);
}
if (spawnSync('cloudflared', ['--version']).error) {
  console.error('cloudflared is not installed. Install it with:  brew install cloudflared');
  process.exit(1);
}

const children = [];
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function start(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  children.push(child);
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`\n${name} exited (code ${code}); stopping.`);
      shutdown(code || 1);
    }
  });
  return child;
}

const server = start('server', process.execPath, ['--env-file-if-exists=.env', 'server.js']);
server.stdout.on('data', (d) => process.stdout.write(d));
server.stderr.on('data', (d) => process.stderr.write(d));

// Keep the Mac awake for as long as the server runs.
if (process.platform === 'darwin') start('caffeinate', 'caffeinate', ['-i', '-w', String(server.pid)]);

const tunnel = start('cloudflared', 'cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate']);
let announced = false;
let tunnelLog = '';
const onTunnelOutput = (d) => {
  if (announced) return;
  tunnelLog += d;
  const m = tunnelLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!m) return;
  announced = true;
  const url = m[0];
  console.log(`
┌──────────────────────────────────────────────────────────────
│  Public URL (changes every run, reprint the QR each time)
│  Board:     ${url}/board
│  Check-in:  ${url}/join
│  QR poster: ${url}/qr
│  Admin:     ${url}/admin
│  It may take ~10s before the URL resolves. Ctrl-C to stop.
└──────────────────────────────────────────────────────────────
`);
};
tunnel.stdout.on('data', onTunnelOutput);
tunnel.stderr.on('data', onTunnelOutput);
