import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outRoot = join(repoRoot, 'artifacts', 'blind-review');
const artifactName = 'answer-engine-anonymous';
const stageDir = join(outRoot, artifactName);
const tarPath = join(outRoot, `${artifactName}.tar.gz`);
const zipPath = join(outRoot, `${artifactName}.zip`);

const copiedEntries = [
  'src',
  'test',
  'eval',
  'demo',
  'example-content',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'archive.config.ts',
  'tsconfig.json',
];

const forbiddenMarkers = [
  /lukefwalton/i,
  /luke@/i,
  /\bLuke\b/,
  /\bWalton\b/,
  /Surmado/i,
  /Zenodo/i,
  /doi\.org/i,
  /10\.5281/,
  /ORCID/i,
  /github\.com\/lukefwalton/i,
  /Ask the Archive/i,
  /lukefwalton\.com/i,
  /Scoobert/i,
  /Amazon/i,
  /NAMM/i,
];

const binaryExtensions = new Set([
  '.gz',
  '.zip',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
]);

function cleanOutput() {
  rmSync(stageDir, { recursive: true, force: true });
  rmSync(tarPath, { force: true });
  rmSync(zipPath, { force: true });
  rmSync(join(outRoot, '_scan-tar'), { recursive: true, force: true });
  rmSync(join(outRoot, '_scan-zip'), { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
}

function copyAllowlist() {
  for (const entry of copiedEntries) {
    cpSync(join(repoRoot, entry), join(stageDir, entry), {
      recursive: true,
      errorOnExist: false,
      force: true,
    });
  }

  // Release metadata is intentionally excluded from the blind artifact, so its
  // consistency test would be both non-anonymous and unrunnable here.
  rmSync(join(stageDir, 'test', 'release-metadata.test.ts'), { force: true });
}

function writeReviewPackageMetadata() {
  const packagePath = join(stageDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  packageJson.name = 'answer-engine-review-artifact';
  packageJson.version = '0.1.0';
  packageJson.description =
    'Anonymous review artifact: site-level search over a synthetic archive where every returned answer cites retrieved evidence or refuses.';
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const lockPath = join(stageDir, 'package-lock.json');
  const lockJson = JSON.parse(readFileSync(lockPath, 'utf8'));
  lockJson.name = packageJson.name;
  lockJson.version = packageJson.version;
  if (lockJson.packages?.['']) {
    lockJson.packages[''].name = packageJson.name;
    lockJson.packages[''].version = packageJson.version;
  }
  writeFileSync(lockPath, `${JSON.stringify(lockJson, null, 2)}\n`);
}

function pruneReviewOnlyPlaceholders(dir = stageDir) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const stat = statSync(file);
    if (stat.isDirectory()) {
      pruneReviewOnlyPlaceholders(file);
      if (readdirSync(file).length === 0) rmSync(file, { recursive: true, force: true });
    } else if (name === '.gitkeep') {
      rmSync(file, { force: true });
    }
  }
}

function writeGeneratedDocs() {
  rmSync(join(stageDir, 'docs'), { recursive: true, force: true });
  mkdirSync(join(stageDir, 'docs'), { recursive: true });

  writeFileSync(
    join(stageDir, 'README.md'),
    `# Review Artifact

This anonymous artifact contains a small TypeScript reference implementation plus offline tests and a keyless scaling demo.

Requirements: Node.js 22 or newer and npm.

## Keyless Review Commands

\`\`\`bash
npm ci
npm test
npm run typecheck
npm run demo:run
npm run demo:run -- --natural+synthetic
\`\`\`

## Expected Rejection Check

\`\`\`bash
npm run demo:run -- --natural+synthetic --bits 4
\`\`\`

This command is expected to reject the lower-precision setting and exit non-zero after reporting the caught route flips.

## Optional Commands

\`\`\`bash
# Optional, requires OPENAI_API_KEY
npm run index
npm run eval
npm run eval -- --full
npm run demo:build
\`\`\`

For a short description of the artifact, see [docs/OVERVIEW.md](docs/OVERVIEW.md).
For the scaling demo, see [docs/DEMO.md](docs/DEMO.md).
`,
  );

  writeFileSync(
    join(stageDir, 'docs', 'OVERVIEW.md'),
    `# Overview

This artifact demonstrates a bounded answer engine that separates retrieval, private routing hints, answer generation, citation repair, citation grounding, and refusal checks.

The important offline checks are:

- \`npm test\`: unit tests for corpus loading, no-leak routing, answer validation, citation repair, eval selection, and the demo artifacts.
- \`npm run typecheck\`: strict TypeScript checks.
- \`npm run demo:run\`: a keyless quantization gate that reads committed vectors and query vectors.

The optional commands call OpenAI APIs and require \`OPENAI_API_KEY\`.
`,
  );

  writeFileSync(
    join(stageDir, 'docs', 'DEMO.md'),
    `# Scaling Demo

The \`demo/\` module tests whether a cheaper embedding encoding preserves the verdicts produced by the full-precision committed vectors.

Run these commands from the artifact root:

\`\`\`bash
npm run demo:run
npm run demo:run -- --natural+synthetic
npm run demo:run -- --natural+synthetic --bits 4
\`\`\`

Expected interpretation:

- The default run uses the natural public-domain corpus and should certify the int8 encoding.
- The \`--natural+synthetic\` run adds a small flagged synthetic near-tie and should still certify int8.
- The \`--natural+synthetic --bits 4\` run intentionally pushes the encoding harder and should reject it when route near-ties flip.

This is a gate demonstration: the suite is allowed to say yes or no, and the negative case is part of the artifact.
`,
  );

  writeFileSync(
    join(stageDir, 'demo', 'README.md'),
    `# Scaling Demo

This module contains the keyless quantization demo used by the review artifact.

\`\`\`bash
npm run demo:run
npm run demo:run -- --natural+synthetic
npm run demo:run -- --natural+synthetic --bits 4
\`\`\`

The default and \`--natural+synthetic\` int8 runs should pass. The \`--bits 4\` synthetic run is expected to reject the lower-precision encoding because the constructed near-tie changes route selection.

The optional regeneration path, \`npm run demo:build\`, requires \`OPENAI_API_KEY\`.
`,
  );

  writeFileSync(
    join(stageDir, 'demo', 'corpus', 'README.md'),
    `# The Demo Corpus

This folder holds the corpus for the keyless scaling demo. This README documents the data choices behind that corpus: what each source is, why it is assigned to a layer, and what the demo uses it to test.

If you are scrutinizing the corpus, the main choices are named below.

## What This Corpus Is

A name-collision corpus over two real, public-domain authors who share a name:

- **Adam Smith**, the economist and moral philosopher (1723-1790).
- **George Adam Smith**, the theologian and historical geographer (1856-1942). "Adam" is a middle name; the partial-name match is deliberate and is tested in the gold suite.

Both write dense moral prose about justice, society, and ethics, so the two bodies of work sit close in embedding space. That proximity, not corpus size, is the point: it packs the near-ties where quantization can reorder candidates.

## Build Status

The text bodies are populated from the public-domain sources below. The committed \`index.json\` and \`query-vectors.json\` files let the main demo run without an API key. The optional regeneration path is documented in \`docs/DEMO.md\`.

## Provenance and Public-Domain Status

Every source is listed with the basis for its public-domain status. Public domain is the absence of copyright, not a license: this corpus is public-domain rather than "permissively licensed."

- **US:** published before 1931, so public domain in the USA. As of 1 Jan 2026, works published in 1930 and earlier are public domain in the US.
- **Life-plus-70 jurisdictions:** public domain once the author has been dead 70 years. In 2026 that covers authors who died in 1955 or earlier; George Adam Smith died in 1942 and Adam Smith in 1790, so both are clear.

These IDs and dates were checked during artifact preparation.

| Work (unit) | Author | Pub. | Layer | Source (ID) | PD basis | Notes |
|---|---|---|---|---|---|---|
| _Theory of Moral Sentiments_, "Of Sympathy"; "Justice and Beneficence" | Adam Smith | 1759 (Gutenberg source from 1777 printing) | public | Gutenberg 67363 | US: PD in USA per Gutenberg. Life+70: author d. 1790; term expired | verified; clean PG text |
| _Wealth of Nations_, bk. I ch. 1; bk. I ch. 5 | Adam Smith | 1776 | public | Gutenberg 3300 | US: PD in USA per Gutenberg. Life+70: author d. 1790; term expired | verified; clean PG text |
| _The Book of the Twelve Prophets_, Amos / Hosea / Micah units | George Adam Smith | 1896-98 | public | Gutenberg 43847 | US: PD in USA per Gutenberg. Life+70: author d. 1942; term expired | verified; clean PG text; vol. 1 contains Amos, Hosea, Micah |
| _The Book of Isaiah_, "This Is the Victory... Our Faith" | George Adam Smith | 1888-90 | public | Gutenberg 39767 | US: PD in USA per Gutenberg. Life+70: author d. 1942; term expired | verified; clean PG text; unit taken from vol. 1 |
| _The Forgiveness of Sins, and Other Sermons_, sermons I-III | George Adam Smith | 1904; third printing 1905 | **private** | Internet Archive \`forgivenessofsin00smitrich\` (ARK \`ark:/13960/t0gt5jk4g\`); HathiTrust/Online Books Page listing (alternate HathiTrust scan surfaced as ARK \`ark:/13960/t0zp4cz00\`) | US: pre-1931 / IA metadata says NOT_IN_COPYRIGHT in US; visible notice date 1904. Life+70: author d. 1942; term expired | verified against IA metadata XML + direct IA OCR; HathiTrust page view blocked during preparation, so the alternate ARK is recorded as a separate scan/copy, not the OCR source used. OCR-noisy, kept as source character |
| <edge-case note> | n/a (fabricated) | n/a | **synthetic** | authored here | n/a (fabricated demo text) | quarantined in \`synthetic/\`; tests the synthetic route near-tie |

**Sourcing.** George's major commentaries are confirmed on Project Gutenberg. The private layer rests on _The Forgiveness of Sins, and other Sermons_ (copyright 1904; third printing 1905), whose Internet Archive OCR supplies short sermon units that route without restating. _Jeremiah: Being the Baird Lecture for 1922_ (1923) remains a further minor source if a future corpus expansion needs it.

**Sermon length.** The private ledger uses sermons I-III ("The Forgiveness of Sins," "The Word of God," and "Temptation") as whole units. No sermon unit was split into windows.

## URLs: Demo Citations and Real Route Targets

A record's citation URL is constructed by the reused \`src/corpus.ts\` path (\`baseUrl + urlPrefix + slug\`) under the reserved \`.example\` TLD, so it is a stable demo surface rather than a live page; the real sources are the provenance table above. A private note's \`about\` field is taken verbatim from frontmatter, so those route targets are real public George pages.

This differs from a possible design in which every record carries a real source URL; here, demo-canonical record URLs are stable \`.example\` citations, while provenance is documented in this README.

## Authored Choices

**1. The corpus is partly fabricated, and the claim does not depend on its realism.** The public layer is real public-domain text. The private layer is real George Adam Smith minor work. The synthetic notes are a small, flagged set. The demo's claim is relative: int8 preserves the verdicts full precision produces, and where it does not, the gate catches it. Realism is not asserted.

**2. "Private" is a layer assignment, not a claim of secrecy.** George Adam Smith was a public figure and all his work is published; designating some of it private means only that the type cannot carry its text to the model, regardless of what the text is. The demo exposes the full private text on purpose: seeing the full private text, then watching the type admit only its routing hint, is the demonstration. The committed vectors are safe here because they derive from public-domain text. Do not copy that pattern to genuinely private corpora; embeddings of genuinely private text can expose approximate source content.

**3. No fabricated words are passed off as either real Smith's writing.** Every fabricated note lives in the quarantined \`synthetic/\` directory, carries \`synthetic: true\`, and names the edge case it tests. Real George material is handled as George's; synthetic text is marked as synthetic.

**4. The corpus is not tuned so int8 passes.** Headline numbers come from the real-only (\`--natural\`) run. The demo deliberately includes a failure: a tightened encoding breaking a route case, caught by the gold suite.

**5. Themes are authored honestly, including where they collide.** Both Smiths carry shared themes such as "justice," so a verbatim theme match can hand the boost to the wrong Smith. That misfire is a near-tie the gold suite exposes, not one smoothed away by curation.

**6. The public/private split is a research decision, stated as one.** Major, legible George works go to the public records layer; minor, windy works go to the private routing layer. This exercises both the disambiguation path and the routing path without confounding them.

**7. The synthetic layer is deliberately small.** It exists only to create a controlled near-tie that the real text did not provide at the chosen precision.
`,
  );
}

function normalizeCopiedText() {
  const replacements = [
    [/\bLuke\b/g, 'Lk.'],
    [/\bWalton\b/g, 'Author'],
    [/lukefwalton/gi, 'anonymous'],
    [/luke@/gi, 'contact@'],
    [/Surmado/gi, 'Review Service'],
    [/Zenodo/gi, 'archive service'],
    [/doi\.org/gi, 'doi.example'],
    [/10\.5281/g, '10.xxxx'],
    [/ORCID/g, 'researcher identifier'],
    [/github\.com\/lukefwalton/gi, 'example.com/anonymous'],
    [/Ask the Archive/g, 'the deployed archive'],
    [/lukefwalton\.com/gi, 'example.com'],
    [/Scoobert/gi, 'User'],
    [/Amazon/g, 'Marketplace'],
    [/NAMM/g, 'Music trade event'],
    [/docs\/scaling-demo\/build-handoff\.md/g, 'docs/DEMO.md'],
    [/build-handoff\.md/g, 'docs/DEMO.md'],
    [/build-handoff §\d+/g, 'docs/DEMO.md'],
    [/build-handoff/g, 'docs/DEMO.md'],
    [
      /See the delta log for this divergence\s+\/\/ from the spec's "records carry real public URLs" assumption and why it keeps\s+\/\/ src\/corpus\.ts untouched\./g,
      'Record URLs are demo-canonical .example citations; provenance is documented in demo/corpus/README.md.',
    ],
    [/the delta log/gi, 'the artifact notes'],
    [/the spec's "records carry real public URLs" assumption/gi, 'a design with real source URLs for every record'],
    [/paper-reaching chunking watch-item/gi, 'chunking check'],
    [
      /The public, runnable twin of the production site adapter's vector-quant\.ts\s+\/\/ \(named in docs\/production-scaling\.md §2; that adapter is not a public repo\)\./g,
      'A compact scalar-quantization module for the public, runnable demo.',
    ],
    [/docs\/production-scaling\.md §2/g, 'docs/DEMO.md'],
    [/the paper's §6 split/g, 'the exact-versus-measured split'],
  ];

  for (const file of listFiles(stageDir)) {
    if (!isTextFile(file)) continue;
    let text = readFileSync(file, 'utf8');
    let changed = false;
    for (const [pattern, replacement] of replacements) {
      const next = text.replace(pattern, replacement);
      if (next !== text) changed = true;
      text = next;
    }
    if (changed) writeFileSync(file, text);
  }
}

function listFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const stat = statSync(file);
    if (stat.isDirectory()) files.push(...listFiles(file));
    else files.push(file);
  }
  return files;
}

function isTextFile(file) {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  if (binaryExtensions.has(ext)) return false;
  const chunk = readFileSync(file);
  return !chunk.subarray(0, 4096).includes(0);
}

function markerHits(dir) {
  const hits = [];
  for (const file of listFiles(dir)) {
    if (!isTextFile(file)) continue;
    const text = readFileSync(file, 'utf8');
    const rel = relative(dir, file);
    for (const marker of forbiddenMarkers) {
      const match = text.match(marker);
      if (match) hits.push(`${rel}: ${marker} matched "${match[0]}"`);
    }
  }
  return hits;
}

function assertNoMarkers(dir, label) {
  const hits = markerHits(dir);
  if (hits.length > 0) {
    throw new Error(`identity marker scan failed for ${label}:\n${hits.join('\n')}`);
  }
}

function createArchives() {
  execFileSync('tar', ['-czf', tarPath, artifactName], { cwd: outRoot, stdio: 'inherit' });
  execFileSync('zip', ['-qry', basename(zipPath), artifactName], { cwd: outRoot, stdio: 'inherit' });
}

function scanArchiveContents() {
  const tarScanDir = join(outRoot, '_scan-tar');
  const zipScanDir = join(outRoot, '_scan-zip');
  rmSync(tarScanDir, { recursive: true, force: true });
  rmSync(zipScanDir, { recursive: true, force: true });
  mkdirSync(tarScanDir, { recursive: true });
  mkdirSync(zipScanDir, { recursive: true });

  execFileSync('tar', ['-xzf', tarPath, '-C', tarScanDir], { stdio: 'inherit' });
  execFileSync('unzip', ['-q', zipPath, '-d', zipScanDir], { stdio: 'inherit' });

  assertNoMarkers(tarScanDir, `${basename(tarPath)} contents`);
  assertNoMarkers(zipScanDir, `${basename(zipPath)} contents`);

  rmSync(tarScanDir, { recursive: true, force: true });
  rmSync(zipScanDir, { recursive: true, force: true });
}

function assertExpectedFiles() {
  const required = [
    'README.md',
    'docs/OVERVIEW.md',
    'docs/DEMO.md',
    'src',
    'test',
    'eval',
    'demo',
    'example-content',
    'package.json',
    'package-lock.json',
    'LICENSE',
    'archive.config.ts',
    'tsconfig.json',
  ];
  const excluded = [
    'REVIEW_ARTIFACT.md',
    'CITATION.cff',
    '.zenodo.json',
    'NOTICE',
    'CONTRIBUTING.md',
    'NEXT-STEPS.md',
    '.github',
    'scripts',
  ];

  for (const entry of required) {
    if (!existsSync(join(stageDir, entry))) throw new Error(`missing required artifact entry: ${entry}`);
  }
  for (const entry of excluded) {
    if (existsSync(join(stageDir, entry))) throw new Error(`excluded artifact entry was copied: ${entry}`);
  }
}

cleanOutput();
copyAllowlist();
writeReviewPackageMetadata();
writeGeneratedDocs();
normalizeCopiedText();
pruneReviewOnlyPlaceholders();
assertExpectedFiles();
assertNoMarkers(stageDir, 'staging checkout');
createArchives();
scanArchiveContents();

console.log(`Wrote ${stageDir}`);
console.log(`Wrote ${tarPath}`);
console.log(`Wrote ${zipPath}`);
