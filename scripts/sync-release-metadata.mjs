#!/usr/bin/env node
/**
 * Sync version-bearing metadata for a release tag.
 * Usage: node scripts/sync-release-metadata.mjs <semver>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('Usage: node scripts/sync-release-metadata.mjs <semver>');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.version = next;
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
lock.version = next;
if (lock.packages?.['']) lock.packages[''].version = next;
writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);

const zenodo = JSON.parse(readFileSync('.zenodo.json', 'utf8'));
zenodo.version = next;
writeFileSync('.zenodo.json', `${JSON.stringify(zenodo, null, 2)}\n`);

let cff = readFileSync('CITATION.cff', 'utf8');
cff = cff.replace(/^version: .+$/m, `version: ${next}`);
cff = cff.replace(/^date-released: .+$/m, `date-released: "${today}"`);
cff = cff.replace(/^(\s+version: ).+$/m, `$1${next}`);
cff = cff.replace(/^(\s+date-released: ).+$/m, `$1"${today}"`);

const topVersion = cff.match(/^version: (.+)$/m)?.[1];
const topDate = cff.match(/^date-released: "(.+)"$/m)?.[1];
const preferredBlock = cff.match(/^preferred-citation:[\s\S]*?(?=^(?:references|$))/m)?.[0] ?? '';
const preferredVersion = preferredBlock.match(/^\s+version: (.+)$/m)?.[1];
const preferredDate = preferredBlock.match(/^\s+date-released: "(.+)"$/m)?.[1];

if (topVersion !== next || preferredVersion !== next) {
  throw new Error(
    `Expected version ${next} in CITATION.cff (top=${topVersion}, preferred=${preferredVersion}).`,
  );
}
if (topDate !== today || preferredDate !== today) {
  throw new Error(
    `Expected date-released ${today} in CITATION.cff (top=${topDate}, preferred=${preferredDate}).`,
  );
}

writeFileSync('CITATION.cff', cff);

console.log(`Synced release metadata to ${next} (${today}).`);
