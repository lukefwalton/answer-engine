import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const METADATA_FILES = [
  'package.json',
  'package-lock.json',
  'CITATION.cff',
  '.zenodo.json',
  'README.md',
] as const;

test('sync-release-metadata updates all version-bearing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-meta-'));
  for (const file of METADATA_FILES) {
    cpSync(join(repoRoot, file), join(dir, file));
  }

  execFileSync(
    process.execPath,
    [join(repoRoot, 'scripts/sync-release-metadata.mjs'), '2.0.0'],
    { cwd: dir },
  );

  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  const zenodo = JSON.parse(readFileSync(join(dir, '.zenodo.json'), 'utf8'));
  const cff = readFileSync(join(dir, 'CITATION.cff'), 'utf8');

  assert.equal(pkg.version, '2.0.0');
  assert.equal(lock.version, '2.0.0');
  assert.equal(lock.packages[''].version, '2.0.0');
  assert.equal(zenodo.version, '2.0.0');
  assert.match(cff, /^version: 2\.0\.0$/m);
  assert.match(cff, /^date-released: "\d{4}-\d{2}-\d{2}"$/m);
  assert.match(cff, /^\s+version: 2\.0\.0$/m);

  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  // the release-baseline reference is bumped to the new version...
  assert.match(readme, /latest `v\*` tag on the remote \(`v2\.0\.0`/);
  // ...while the illustrative version examples in the prose are left alone.
  assert.match(readme, /skip `v1\.4\.0` and cut `v1\.4\.1`/);
});
