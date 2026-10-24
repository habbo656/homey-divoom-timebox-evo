#!/usr/bin/env node
// `homey app run --remote` without the Athom cloud (#80 follow-up): the Homey CLI always resolves the Homey through the
// cloud (profile, Homey list, delegation token) before it talks to the Homey on the LAN, which hits the cloud rate limit
// ("Too many requests"). The CLI's `homey api --token --address` already has a purely local path (HomeyAPIV3Local with an
// owner API key); this wrapper hands that same local Homey object to the CLI's own `App.run`, so a dev run needs no cloud
// login and makes no cloud request.
//
//   node scripts/homey-dev-run.mjs check   verify the key reaches the Homey and may run apps (scope homey.app); no install
//   node scripts/homey-dev-run.mjs run     = `homey app run --remote` (used by scripts/homey-run.sh; never --clean)
//
// Key: HOMEY_TOKEN + HOMEY_ADDRESS from the environment, the gitignored .homey-api.env, or
// ${HOMEY_API_ENV:-~/.config/divoom-timebox/homey-api.env} (same lookup as scripts/homey-api.sh). Exit 3 = no key,
// 4 = Homey unreachable or key rejected, 5 = key lacks the scope homey.app. Never prints the key or the address.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readKey() {
  const env = { HOMEY_TOKEN: process.env.HOMEY_TOKEN || '', HOMEY_ADDRESS: process.env.HOMEY_ADDRESS || '' };
  const files = [
    path.join(root, '.homey-api.env'),
    process.env.HOMEY_API_ENV || path.join(os.homedir(), '.config', 'divoom-timebox', 'homey-api.env'),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line
        .slice(i + 1)
        .trim()
        .replace(/^"|"$/g, '');
      if (k in env && !env[k]) env[k] = v;
    }
  }
  // Tolerate a doubled scheme and a trailing slash, like scripts/homey-api.sh.
  let address = env.HOMEY_ADDRESS;
  while (/^https?:\/\/https?:\/\//.test(address)) address = address.replace(/^https?:\/\//, '');
  return { token: env.HOMEY_TOKEN, address: address.replace(/\/+$/, '') };
}

function cliRoot() {
  const bin = execFileSync('/usr/bin/env', ['sh', '-c', 'command -v homey'], { encoding: 'utf8' }).trim();
  return path.resolve(path.dirname(fs.realpathSync(bin)), '..');
}

function fail(code, message) {
  console.error(`HOMEY-DEV-RUN: ${message}`);
  process.exit(code);
}

const mode = process.argv[2];
if (mode !== 'check' && mode !== 'run') fail(2, 'usage: homey-dev-run.mjs check|run');

const { token, address } = readKey();
if (!token || !address) fail(3, 'no HOMEY_TOKEN/HOMEY_ADDRESS (see docs/pipeline.md, "Homey without the cloud")');

const cli = cliRoot();
const requireCli = createRequire(path.join(cli, 'package.json'));
const { HomeyAPIV3Local } = requireCli('homey-api');
const homey = new HomeyAPIV3Local({
  properties: {
    id: 'lan-homey',
    name: 'Homey (LAN)',
    softwareVersion: '0.0.0',
    [address.startsWith('https:') ? 'localUrlSecure' : 'localUrl']: address,
  },
  strategy: [],
  baseUrl: address,
  token,
});

// Scope probe without side effects: reading the output of a non-existent dev session answers 404 with the scope
// homey.app and "Missing Scopes" (403) without it.
async function probe() {
  try {
    await homey.call({ method: 'GET', path: '/api/manager/devkit/std/scope-probe' });
    return 'ok';
  } catch (err) {
    // Judge by the HTTP status only: a DNS or connection error (e.g. ENOTFOUND) has none and must not pass.
    // Verified 2026-10-24: missing scope → 403 "Missing Scopes" (checked before routing), bad key → 401, scope → 404.
    const status = err?.statusCode ?? err?.status;
    if (status === 404) return 'ok';
    if (status === 403) return 'scope';
    if (status === 401) return 'auth';
    const msg = String(err?.message || err).split('\n')[0];
    return `unreachable (${status ?? 'no HTTP status'}: ${msg
      .replace(/https?:\/\/\S+/g, '<homey>')
      .replace(/(ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT) \S+/g, '$1 <homey>')
      .slice(0, 120)})`;
  }
}

const state = await probe();
if (state === 'scope') fail(5, 'the API key lacks the scope homey.app (needed to run apps); create a key with it');
if (state === 'auth') fail(4, 'the Homey rejected the API key');
if (state !== 'ok') fail(4, `Homey not reachable on the LAN: ${state}`);

if (mode === 'check') {
  console.log('HOMEY-DEV-RUN: OK (LAN token mode, scope homey.app present; no cloud login needed)');
  process.exit(0);
}

// Hand the local Homey to the CLI: App.run, install, the std stream and the Ctrl-C/SIGTERM uninstall all go through
// AthomApi.getActiveHomey(); the cloud login in AthomApi is never reached.
const AthomApi = requireCli(path.join(cli, 'services', 'AthomApi.js'));
AthomApi.getActiveHomey = async () => homey;
const AppFactory = requireCli(path.join(cli, 'lib', 'AppFactory.js'));
console.log('HOMEY-DEV-RUN: running the app on the Homey over the LAN (no cloud login)');
try {
  const app = AppFactory.getAppInstance(process.cwd());
  await app.run({ clean: false, remote: true, skipBuild: false });
} catch (err) {
  console.error(err?.stack || err);
  process.exit(1);
}
