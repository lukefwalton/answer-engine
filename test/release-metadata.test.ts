import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

test('sync-release-metadata accepts a pre-release version and bumps the README baseline to it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-meta-pre-'));
  for (const file of METADATA_FILES) {
    cpSync(join(repoRoot, file), join(dir, file));
  }
  execFileSync(process.execPath, [join(repoRoot, 'scripts/sync-release-metadata.mjs'), '3.0.0-alpha.1'], { cwd: dir });
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '3.0.0-alpha.1');
  assert.match(readFileSync(join(dir, 'CITATION.cff'), 'utf8'), /^version: 3\.0\.0-alpha\.1$/m);
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.match(readme, /latest `v\*` tag on the remote \(`v3\.0\.0-alpha\.1`/);
  // A second sync from the pre-release baseline still finds the line.
  execFileSync(process.execPath, [join(repoRoot, 'scripts/sync-release-metadata.mjs'), '3.0.0'], { cwd: dir });
  assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /latest `v\*` tag on the remote \(`v3\.0\.0`/);
  // Junk is refused.
  assert.throws(() =>
    execFileSync(process.execPath, [join(repoRoot, 'scripts/sync-release-metadata.mjs'), '3.0.0-alpha'], { cwd: dir, stdio: 'pipe' }),
  );
});

test('next-version: releases bump, pre-release lines start, continue, and finalize', async () => {
  // A .mjs has no declaration file; import it by URL so the test stays typed on its own terms.
  const { nextVersion, isPrerelease } = (await import(pathToFileURL(join(repoRoot, 'scripts/next-version.mjs')).href)) as {
    nextVersion: (latest: string, bump: string, preid?: string) => string;
    isPrerelease: (version: string) => boolean;
  };
  assert.equal(nextVersion('v2.1.0', 'patch'), '2.1.1');
  assert.equal(nextVersion('v2.1.0', 'minor'), '2.2.0');
  assert.equal(nextVersion('v2.1.0', 'major'), '3.0.0');
  assert.equal(nextVersion('v2.1.0', 'premajor'), '3.0.0-alpha.1');
  assert.equal(nextVersion('v2.1.0', 'premajor', 'rc'), '3.0.0-rc.1');
  assert.equal(nextVersion('v3.0.0-alpha.1', 'prerelease'), '3.0.0-alpha.2');
  assert.equal(nextVersion('v3.0.0-alpha.2', 'major'), '3.0.0');
  assert.equal(nextVersion('v3.0.0-alpha.2', 'minor'), '3.0.0');
  assert.equal(nextVersion('v3.0.0-alpha.2', 'patch'), '3.0.0');
  assert.equal(nextVersion('3.0.0', 'patch'), '3.0.1'); // with or without the v
  assert.throws(() => nextVersion('v2.1.0', 'prerelease'), /is a release; use premajor/);
  assert.throws(() => nextVersion('v3.0.0-alpha.1', 'premajor'), /already a pre-release/);
  assert.throws(() => nextVersion('v2.1', 'patch'), /is not MAJOR\.MINOR\.PATCH/);
  assert.throws(() => nextVersion('v2.1.0', 'bigger'), /unknown bump/);
  assert.equal(isPrerelease('3.0.0-alpha.1'), true);
  assert.equal(isPrerelease('3.0.0'), false);

  // The CLI form the workflow calls.
  const out = execFileSync(process.execPath, [join(repoRoot, 'scripts/next-version.mjs'), 'v2.1.0', 'premajor'], {
    encoding: 'utf8',
  });
  assert.equal(out.trim(), '3.0.0-alpha.1');
});
