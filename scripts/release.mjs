// Publishes a release: node scripts/release.mjs "release notes"
// Run after `npx tauri build` with TAURI_SIGNING_PRIVATE_KEY_PATH set; needs the GitHub CLI (`gh`) signed in.
// Uploads the installer, its signature and latest.json (what installed apps read to find updates).
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const version = conf.version;
const repo = process.env.VAULT_REPO || 'JustSad42/vault';
const target = process.env.CARGO_TARGET_DIR || 'src-tauri/target';
const dir = path.join(target, 'release', 'bundle', 'nsis');
const exe = readdirSync(dir).find(f => f.startsWith(`Vault_${version}_`) && f.endsWith('-setup.exe'));
if (!exe || !existsSync(path.join(dir, exe + '.sig'))) throw new Error(`no signed installer for ${version} in ${dir}: run the build with TAURI_SIGNING_PRIVATE_KEY_PATH set`);
const notes = process.argv[2] || `Vault ${version}`;
const tag = `v${version}`;
const latest = {
  version, notes, pub_date: new Date().toISOString(),
  platforms: { 'windows-x86_64': { signature: readFileSync(path.join(dir, exe + '.sig'), 'utf8').trim(), url: `https://github.com/${repo}/releases/download/${tag}/${exe}` } },
};
const latestPath = path.join(dir, 'latest.json');
writeFileSync(latestPath, JSON.stringify(latest, null, 2));
execFileSync('gh', ['release', 'create', tag, path.join(dir, exe), path.join(dir, exe + '.sig'), latestPath, '--repo', repo, '--title', `Vault ${version}`, '--notes', notes], { stdio: 'inherit' });
console.log(`published ${tag}`);
