#!/usr/bin/env node
// The release workflow's version arithmetic, in one testable place.
// Usage: node scripts/next-version.mjs <latest tag or version> <bump> [preid]
//   bump: patch | minor | major | premajor | prerelease
//
// A pre-release line is `X.Y.Z-<preid>.N`. `premajor` starts one from a release
// (2.1.0 → 3.0.0-alpha.1); `prerelease` continues it (3.0.0-alpha.1 →
// 3.0.0-alpha.2); patch, minor, or major on a pre-release finalize it to its
// base version (3.0.0-alpha.2 → 3.0.0). On a release, patch/minor/major bump as
// usual. Anything else is refused with the reason.

import { fileURLToPath } from 'node:url';

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+)\.(\d+))?$/;

export function nextVersion(latest, bump, preid = 'alpha') {
  const m = VERSION.exec(latest);
  if (!m) {
    throw new Error(`'${latest}' is not MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-<preid>.N (with or without a leading v).`);
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const pre = m[4] !== undefined ? { id: m[4], n: Number(m[5]) } : null;
  switch (bump) {
    case 'prerelease':
      if (!pre) throw new Error(`'${latest}' is a release; use premajor to start a pre-release line.`);
      return `${major}.${minor}.${patch}-${pre.id}.${pre.n + 1}`;
    case 'premajor':
      if (pre) throw new Error(`'${latest}' is already a pre-release; use prerelease to continue it or major to finalize it.`);
      if (!/^[0-9A-Za-z-]+$/.test(preid)) throw new Error(`pre-release id '${preid}' must be alphanumeric.`);
      return `${major + 1}.0.0-${preid}.1`;
    case 'major':
      return pre ? `${major}.${minor}.${patch}` : `${major + 1}.0.0`;
    case 'minor':
      return pre ? `${major}.${minor}.${patch}` : `${major}.${minor + 1}.0`;
    case 'patch':
      return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`unknown bump '${bump}'; expected patch, minor, major, premajor, or prerelease.`);
  }
}

/** True for `X.Y.Z-<preid>.N`. */
export function isPrerelease(version) {
  const m = VERSION.exec(version);
  if (!m) throw new Error(`'${version}' is not a version.`);
  return m[4] !== undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [latest, bump, preid] = process.argv.slice(2);
  if (!latest || !bump) {
    console.error('Usage: node scripts/next-version.mjs <latest tag or version> <patch|minor|major|premajor|prerelease> [preid]');
    process.exit(1);
  }
  try {
    console.log(nextVersion(latest, bump, preid));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
