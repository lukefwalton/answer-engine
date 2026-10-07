# The archive contract

**Status.** Design of record for answer-engine 3.0.0, and the text the
implementation is read against. Implemented in this package on the 3.0.0 line:
the types (§2), disclosure and its resolution (§3), the crossing (§4),
projections (§5), the lints (§6), retrieval with plugins and filters (§7), the
in-package consumer (§9), the private and served index with load-time
validation and the keyless migration (§12), and the evaluation's canary sweep
and fragment ids (§11), and the wire contract's types, fixed policy copy, and
`toSearchResponse` (§8, `src/wire.ts`). Not in this package by design: the
transport and the retrieval-only consumer itself, which a consumer implements
over `searchWithCounts()` and `toSearchResponse` (§15). Still owed in this
repository: the demo's `semantic` entity (§12, a keyed build). The charter files were revised with the code in the same release:
`.github/STANDARDS.md`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`,
`NEXT-STEPS.md`, and `docs/production-scaling.md`. Where this document and the
code disagree, the disagreement is a bug in one of them, and `CHANGELOG.md`
says which release changed what.

**One sentence.** Every retrievable piece of an archive carries a disclosure
policy; the only object a consumer may hand to a model or a caller is a hit, and
a hit's type cannot hold more than that policy allows.

The examples in this document are illustrative. No gist printed here is a served
gist, and the private-layer example uses the demo's public-domain novel.

## 0. What changes, and why

Today the engine has two layers named by type: an `ArchiveRecord` is quotable, a
`PrivateNote` is searchable but reduced to a `RoutingHint` with no text field
before the answer model sees it. That boundary works, and it stays. Four things
it cannot do are the reason for this contract.

1. It cannot say "this material may be *described* but never quoted." A
   copyrighted book, or any text the archive holds but does not own the right to
   republish, is either fully quotable or reduced to a location. There is no
   middle exposure.
2. The boundary sits at `assembleEvidence`, just before the model. Retrieval
   output still carries the private text. A retrieval-only consumer, one that
   returns hits to a caller instead of synthesizing an answer, needs the crossing
   at the retrieval output, and needs its serializer typed on the crossed object.
3. A hit carries almost no provenance. A hint carries a label, a locator, and a
   URL; a record carries an optional date and nothing else. Neither has a field
   for a version, a creator, a catalogue identifier, or a locator inside the
   source. A caller that wants to reason about *when* something was said and
   *who* said it cannot.
4. Two consumers cannot share one `retrieve()`. The production deployment
   carries its own copy of retrieval with six boosts this package does not have.
   Scoring needs a plugin seam so that one core serves both.

The contract fixes those four things and nothing else. It does not add a vector
database, a graph, an agent, a permission framework, an HTTP layer, or a
production synthesis service to this package.

Two consumers are in view. The constrained question-answering product exists
today in two copies: a teaching-sized one inside this package (`src/answer.ts`,
`src/prompt.ts`, `src/cli/ask.ts`, the `--full` tier of `src/cli/eval.ts`, and
the answer step of `demo/run.ts`) and the production one in the site's
`ask-the-archive/`, which does not yet import this package. Under 3.0.0 the
in-package copy stays, as the reference consumer the gold suite's full tier
exercises, consuming hits; the production copy imports this package. The
retrieval-only consumer does not exist yet.

```
corpus -> ingest -> index -> retrieve() -> ScoredHit[] -> project() -> EvidenceHit[]
                                                                          |-> consumer A: constrained synthesis (cite or refuse)
                                                                          '-> consumer B: retrieval only (the caller's model thinks)
```

### Compatibility with the 2.x guarantees

Until 3.0.0 ships, the 2.x code and the gold suite's semantics are the source
of truth, and this document changes none of them. Three guarantees carry over
unchanged, restated in the new vocabulary so no reader mistakes the extension
for a loosening:

- Private text never reaches a model. In 2.x the type that crosses is
  `RoutingHint`; here it is the `locator` and `semantic` variants of
  `EvidenceHit`, neither of which has a field for the source text.
- Provenance is not grounding. A hit says where something is and who made it;
  whether a hit may back a claim in an answer is decided by the synthesis
  consumer's citation gate (exact retrieved identifier and URL, mode derived
  from the final citation mix, empty refusal), which this contract does not
  touch.
- A refusal is empty and uncited; `not-found` and the four modes keep their
  2.x meaning (section 9).

## 1. Vocabulary

- **Entity.** An identifiable thing in the archive: a book, a paper, an essay, a
  song recording, a podcast episode, a transcript, a page, a letter. It has
  identity and provenance: title, type, creators, date, version, a canonical
  URL, and identifiers.
- **Fragment.** A retrievable part of an entity: a page, a chapter, a section, a
  timecode window, or the whole of a short entity. It carries the retrieval
  text, an embedding, a locator inside its entity, and a disclosure policy.
- **Identifier.** A catalogue number on an entity or a person, as a
  `{scheme, value}` pair. The scheme set is open: `isbn`, `isrc`, `iswc`,
  `ipi`, `isni`, `doi`, `orcid`, `url`, `spotify`, `wikidata`. One bucket, no
  per-scheme fields.
- **Locator.** Where a fragment sits in its entity, as `{scheme, value, end?}`.
  The scheme set is open: `whole` (the fragment is its entire entity), `page`,
  `chapter`, `section`, `paragraph`, `timecode`, `chunk` (one of several
  windows), `note`. `end` is set only for ranges and is inclusive. `timecode`
  values are decimal seconds with `.` as the separator, no unit, integers when
  whole. A compound locator is ordered coarse to fine (`chapter` before `page`).
- **Attribution.** Who made or spoke something: a name, an optional role, and
  optional identifiers. On an entity it names creators; on a fragment it names
  the speakers in that window. Two placeholders are structural, not names of
  people: `placeholder: 'unnamed'` (a speaker who is not a creator and is not
  named, labelled `Other` today) and `placeholder: 'unverified'` (attribution
  not established).
- **Disclosure.** Two dimensions on every fragment: `raw`, whether the source
  text is public or private; and `exposure`, what a hit may carry about it:
  `text`, `semantic`, `locator`, or `none`.
- **Projection.** A short description of what a fragment is about, written to be
  served in place of the text. Drafted by the system at ingest, stored as
  private material, released only by policy.
- **Hit.** The one object that leaves the substrate toward a model or a caller.
  Its type is a union on `exposure`, so a hit for a `locator` fragment has no
  field that could hold text.
- **Substrate.** This package. **Consumer.** Anything that imports it.

Plain English throughout. The engine's own two phrases stay: a private moment is
reduced to a *routing hint*, and *retrieved is not cited*. The wider pattern this
package instantiates is named *framed automation* in the companion paper
(*Building Answerable AI: Framed Automation*, Walton 2026, concept DOI
10.5281/zenodo.20682306); the term is cited, not redefined, here.

The one guarantee has one name: **disclosure on the served path**. Where this
document says "the boundary," it means that.

## 2. Types

Normative. Field order and comments are informative. The file is
`src/contract.ts`; brands are defined in `src/public-safe.ts` and re-exported.

```ts
export interface Identifier  { scheme: string; value: string }
export interface Locator     { scheme: string; value: string; end?: string }
export interface Attribution { name: string; role?: string; identifiers?: Identifier[]; placeholder?: 'unnamed' | 'unverified' }

export type Exposure = 'text' | 'semantic' | 'locator' | 'none';
export type ServedExposure = Exclude<Exposure, 'none'>;

/** private + text is not a member of this union. */
export type Disclosure =
  | { raw: 'public';  exposure: Exposure }
  | { raw: 'private'; exposure: 'semantic' | 'locator' | 'none' };

export interface Entity {
  id: string;                 // `${type}:${slug}`; today's record ids are kept
  type: string;               // open: book, paper, essay, song, album, episode, transcript, page, letter, ...
  title: string;
  attribution: Attribution[]; // creators
  date?: string;              // YYYY, YYYY-MM, or YYYY-MM-DD; absent means unknown, never guessed
  version?: string;           // edition, preprint version, "manuscript"
  url: string;                // the accountable surface a citation links to
  identifiers: Identifier[];
  parent?: string;            // entity id this one belongs to (a transcript's episode)
  themes?: string[];          // consumer boost input
  disclosure: Disclosure;     // entity default; a fragment may override `exposure`, never `raw`
  policy?: {                  // authored declarations; stripped from a served index
    requireReview?: boolean;  // a gist is servable only once `review` is 'reviewed'
    publicTitle?: boolean;    // the title is public by construction; bounded, not checked against the text (section 6)
    lint?: { ngramWords?: number; ngramChars?: number; gistMaxChars?: number }; // the lints' window for this entity (section 6)
  };
}

/** A gist the lint has passed. Constructible only through assertSemanticProjection (section 6). */
export type LintedGist = string & { readonly __lint: 'gist' };

interface ProjectionBase {
  source: 'generated' | 'edited';
  review: 'unreviewed' | 'reviewed';
  vetoed?: boolean;
  stale?: boolean;            // an edited gist whose fragment text changed afterwards
  contentHash: string;        // sha1 of the fragment text the gist was drafted or edited against
  model?: string; promptVersion?: string; generatedAt?: string;
}
export type SemanticProjection =
  | (ProjectionBase & { lint: 'passed'; gist: LintedGist })
  | (ProjectionBase & { lint: 'failed'; draft: string });   // never servable; kept for the author to edit

/** Index-side. `disclosure` is the RESOLVED policy (section 3), stored at build. */
export interface Fragment {
  id: string;                 // `${entityId}#${key}`: book:x#p184, transcript:y#12, writing:z#s3
  entityId: string;
  locator: Locator[];
  text: string;               // the embedded text; '' in a served index unless exposure is `text`
  disclosure: Disclosure;     // raw equals the entity's; exposure is the resolved value
  projection?: SemanticProjection;
  attribution?: Attribution[];      // speakers in this window
  date?: string;              // overrides the entity date for this fragment
  summary?: string;           // a public liftable summary; '' in a served index unless exposure is `text`
  themes?: string[];
  sourceReview?: 'unreviewed' | 'in-review' | 'reviewed';   // review of the SOURCE (transcript attribution); not the gist
}

/** What retrieve() returns. Internal to the process; never serialized. */
export interface ScoredHit {
  fragment: Fragment;
  entity: Entity;
  cosine: number;
  score: number;
  breakdown: Record<string, number>;   // { cosine, ...one entry per plugin that fired }
}

interface HitBase {
  fragmentId: string;
  entity: Pick<Entity, 'id' | 'type' | 'title' | 'attribution' | 'date' | 'version' | 'url' | 'identifiers' | 'parent'>;
  raw: 'public' | 'private';  // the policy dimension, not a content field
  locator: Locator[];
  locatorLabel: string;       // rendered from `locator` by renderLocatorLabel(): "p. 184", "12:30–14:05", "ch. 12, §3"
  date?: string;              // the effective date: fragment.date ?? entity.date; absent only when both are unknown
  attribution?: Attribution[];      // the speakers in this window; present whenever the fragment carries speaker data
  score: number;              // public hits: full precision; private hits: rounded to 0.05 (section 4)
  breakdown?: Record<string, number>;   // public hits only; omitted on private hits (section 4)
}

/** The wire type and the boundary. A private fragment's text has no field to travel in. */
export type EvidenceHit =
  | (HitBase & { exposure: 'text';     text: string; summary?: string })
  | (HitBase & { exposure: 'semantic'; gist: LintedGist; gistSource: 'generated' | 'edited'; gistReview: 'unreviewed' | 'reviewed' })
  | (HitBase & { exposure: 'locator' });
// There is no 'none' variant. Such fragments are not in a served index.

export interface SearchRequest {
  q: string;
  limit?: number;             // 1..20, default 10; the total across exposures after filters and floor
  filters?: {
    type?: string[];
    dateFrom?: string; dateTo?: string;          // YYYY, YYYY-MM, or YYYY-MM-DD; interval semantics (section 7)
    undated?: 'include' | 'exclude';             // default 'exclude' when a bound is set
    creator?: string;                            // name match on entity creators
    speaker?: string;                            // name match on fragment speakers; placeholders never match
    exposure?: ServedExposure[];
    raw?: 'public' | 'private';
  };
  recency?: 'none' | 'prefer-recent' | 'auto';
}

export interface SearchResponse {
  contract: 'archive-search/1';
  query: string;
  hits: EvidenceHit[];
  matched: number;            // hits above the floor after filters, before `limit`
  excludedUndated: number;    // fragments dropped by a date bound because they carry no date
  index: { builtAt: string; entityCount: number; fragmentCount: number };   // served counts; no embedding model or dimensions (section 10)
  policy: { exposure: Record<ServedExposure, string>; note: string };     // the fixed copy of section 8
}
```

Two naming rules. The cosine similarity is called `cosine` everywhere in this
package (`ScoredHit.cosine`, `breakdown.cosine`); `semantic` names the exposure
level and nothing else. The 2.x field `ScoredRecord.semantic` is removed, not
aliased. And the dimension is spelled `exposure` everywhere; the prose says
"exposure level."

## 3. Disclosure

| | `exposure: text` | `exposure: semantic` | `exposure: locator` | `exposure: none` |
|---|---|---|---|---|
| `raw: public` | the passage travels (a published page) | a gist travels, the passage does not (a public text the archive does not want to republish, or a long document before it is fragmented) | only where it is | indexed, never served |
| `raw: private` | **not representable** | a gist travels (a copyrighted book, by its author's policy) | only where it is (today's transcript windows) | indexed, never served (a notebook) |

Rules.

1. `raw` is set on the entity and inherited by every fragment. A fragment may
   override `exposure` only, and an override may be more permissive than the
   entity default; that is the author's act. A fragment on a private entity that
   requests `text` is a misauthored input, and `resolveDisclosure` throws with
   the fragment's path.
2. The effective `exposure` is **resolved at build and stored on the fragment**.
   One predicate decides whether a gist may be served, and every later check
   cites it rather than restating it:

   ```ts
   isServableGist(fragment, entity) :=
     fragment.projection !== undefined
     && fragment.projection.lint === 'passed'
     && !fragment.projection.vetoed
     && !fragment.projection.stale
     && (!entity.policy?.requireReview || fragment.projection.review === 'reviewed')
   ```

   `resolveDisclosure(entity, input)` starts from `input.exposure ??
   entity.disclosure.exposure` and may only **downgrade**: a requested `semantic`
   becomes `locator` when `isServableGist` is false. `none` stays `none`.
   Nothing is upgraded by the resolver, and nothing is resolved again at query
   time.
3. A `none` fragment is kept in the private index for a future authenticated
   consumer and is never in a served index.
4. There are two artifacts. The **private index** holds everything (text,
   projections, policy). The **served index** is `toServedIndex(privateIndex)`,
   a projection run last in the build, after embedding and after the lint: it
   drops every `none` fragment and every entity left with no served fragment;
   sets `text` and `summary` to `''` for every fragment whose resolved exposure
   is not `text` (every private fragment, and any public fragment resolved to
   `semantic` or `locator`); drops `projection` for every fragment whose
   resolved exposure is not `semantic`, and on the ones it keeps drops every
   projection field except `gist`, `lint`, `source`, and `review`; drops
   `contentHash`, `policy`, and `sourceReview`. Counts in `SearchResponse.index`
   are served counts. This is defense in depth behind rule 2, in the spirit of
   today's `stripChunkForIndex` in the production adapter, and the load-time
   validator checks that it happened (section 12).

The policy is small on purpose. Two dimensions, one forbidden cell, an entity
default, a fragment override, and one optional review flag. Anything a deployer
needs beyond that is a consumer's concern.

## 4. The crossing: `project()`

`src/no-leak.ts` keeps its name. Its two 2.x exports, `toRoutingHint` and
`assembleEvidence`, are replaced by one, and its first comment is rewritten for
it in the same spirit ("the disclosure boundary; this is the whole file on
purpose"):

```ts
export function project(hit: ScoredHit): EvidenceHit
export function search(queryVector: readonly number[], query: string, index: RetrievalIndex, options?: RetrieveOptions): EvidenceHit[]
// search = retrieve(...).map(project): the path a retrieval-only consumer takes, so it never holds a ScoredHit.
```

Behaviour by resolved exposure:

- `text`: copies `text` and `summary`. The `Disclosure` union already makes this
  branch unreachable for a private fragment; `project()` also throws if it is
  reached with `raw: 'private'`, because a runtime guard behind a type costs
  nothing.
- `semantic`: copies `projection.gist`, `source` as `gistSource`, and `review`
  as `gistReview`. Throws if `isServableGist` is false. A served index in that
  state was misbuilt; the failure is loud, not silent.
- `locator`: copies provenance only.
- `none`: throws. It is never in a served index.

Every variant carries `raw`, the entity provenance, the locator and its rendered
label (`renderLocatorLabel(locator)`, a pure per-scheme renderer: `page` → "p.
184", `timecode` → "12:30–14:05", `chapter` + `section` → "ch. 12, §3", `whole`
→ "whole record"), the effective date, and the speakers.

**Scores on private hits are coarse.** For a fragment whose `raw` is `private`,
`score` is rounded to the nearest 0.05 and `breakdown` is omitted. A
full-precision cosine against a private vector is a measurement of that vector;
a caller who can embed its own queries and read exact scores can take as many
measurements as it has queries, and vectors derived from private text can be
inverted to approximate content. The hit carries a coarse relevance signal, not
the measurement. Consumers that need the exact score for their own selection
read it from `ScoredHit` before projecting; it does not leave the process.

The claim, and its bound. On the typed path, a consumer's prompt builder or
serializer accepts `EvidenceHit`, not `Fragment` or `ScoredHit`. A consumer
holding a hit whose `exposure` is `locator` has no field from which to read the
source text, and one whose `exposure` is `semantic` has only the gist. The
forbidden move is absent from the type, not caught by a check. The bound is this
contract's own: the guarantee holds along the supported path. TypeScript's escape
hatches (`any`, assertions), a deployer who logs a `Fragment`, a hand-built index,
or a consumer that serializes `ScoredHit` are outside what the type can police.
The contribution is to make the leak inexpressible on the supported path, not to
prove that no unsupported path exists.

That is the claim about the **source text**. Every variant also carries short
authored strings: `entity.title` and `version`, the locator values and the
rendered `locatorLabel`, creator and speaker names and roles, themes. Those are
plain strings, and nothing in the type stops an author from putting a sentence
of the manuscript in a title or a `note` locator. That channel is closed by a
check, not a type: the lint of section 6 (`assertPublicSafeMetadata`) runs over
every such string on a private entity, against the entity's private text, at
index build and at every load of a private index, and bounds each to one line
of at most 120 characters. So the structural claim is about the text, and the
metadata claim is about a lint with a stated tripwire (section 13). Section 10
lists both as separate channels.

Trust posture. The `LintedGist` brand erases at JSON boundaries, exactly as the
2.x `PublicSafe` brand does, so a brand proves nothing about a file. A
**private** index read from disk is not trusted: it still holds the text, so the
load-time validator (section 12) re-runs the metadata lint and the gist lint
against it, and a hand-edited title, locator, or gist fails at load with the
field and the position of the run. A
**served** index, or a bundle read from a blob store, has no private text to
check against (that is what the strip is for) and is trusted to descend from a
validated private index; its validator checks the shape and the strip
invariants of rule 4, which is all that can be checked without the text. The
same validation runs at write, so a build cannot leave behind an artifact the
next load refuses. The evaluation's canary sweep (section 11) backstops at eval
time. Nothing re-checks a gist or a string at query time.

## 5. Projections: proposed by the system, authorized by the author

Authorship and authorization are different acts, and the contract keeps them
apart.

**The system proposes, and only where asked.** At ingest, a drafter produces one
gist per fragment **whose requested exposure is `semantic`**. Fragments requested
as `locator` or `none` are never sent to the drafter; the drafter sees only text
whose author asked for a gist. The drafter is an interface; the shipped
implementation calls a hosted model through the Responses API with `store:
false` and a JSON-schema output. The prompt asks for a one-paragraph,
third-person catalogue note of what the passage is about: its situation,
subject, and themes; no quotation, no close paraphrase, no dialogue, no line
breaks, a length cap; and a names rule the author sets per entity in the
drafter's configuration (the pre-publication default forbids naming characters,
places, and invented terms). The names rule is drafter configuration keyed by
entity id, not a contract type.

Each gist is stored with a content hash over the fragment text it was drafted
or edited against, with the drafter's model and the prompt version beside it: a
generated gist is current while all three match, and an edited gist is stale
when the text alone moved, whatever model drafted the original. The ingest
order is: read the requested exposure, draft where it is `semantic`, lint,
resolve, store. Re-running ingest skips unchanged generated gists, never
overwrites a gist whose `source` is `edited` (it re-lints it against the current
text, so an edit that quotes fails at build), and marks an edited gist `stale`
when its fragment text has changed; a stale gist is not servable (rule 2) until
a person re-edits or re-reviews it, because it describes text the author has
since changed. A draft that fails the lint is retried once with the lint's
reason and an instruction to describe rather than quote; a second failure is
stored as `lint: 'failed'` with the draft kept for editing, and the fragment
resolves to `locator`. A veto survives a redraft; review does not. A projection
stored for a fragment the author no longer exposes as `semantic` is carried,
not deleted, so flipping a policy back costs no call. The teaching build keeps
the projections in `artifacts/projections.json`, gitignored with the index and
keyed by fragment id; the author works in that file (`src/ingest/projections.ts`).

**The author authorizes.** A stored gist is private material. It is in the same
custody class as the fragment text it describes: never committed, never served,
unless the fragment's resolved exposure is `semantic`. The author authorizes at
the entity level (`disclosure.exposure`), overrides per fragment, vetoes a single
gist, edits one, or requires per-gist review before release
(`policy.requireReview`). None of that is required for a gist to be served when
the entity policy says `semantic`; all of it is available. A served hit says
which it got: `gistSource` and `gistReview` travel with the gist, so a caller can
tell an author-edited description from an unreviewed machine draft.

**The projection is content.** "It is only a gist" does not bypass the source's
policy. A gist can reveal a plot, a thesis, a name, or more than its author would
choose, and the set of an entity's gists composes into more than any one of them
says. That is why generation is not authorization, why the lint exists, and why
the residue the lint cannot catch (section 13) is owned by the policy, the veto,
and the optional review rather than claimed as guaranteed.

**Nothing is generated at query time.** A request to the substrate retrieves and
projects stored material. No model reads private text in the request path, and
no model decides at request time how much to reveal. That discretionary
boundary is exactly what 2.x removed from the answer path; the contract does not
reintroduce it one layer down.

## 6. The lint

`src/public-safe.ts` keeps `assertPublicSafeField` and adds the gist lint
beside it:

```ts
export const GIST_MAX_CHARS = 400;
export const GIST_NGRAM_WORDS = 5;

export function assertSemanticProjection(
  gist: string,
  ctx: { path: string; fragmentText: string; entityText?: string; maxChars?: number; ngramWords?: number },
): LintedGist
```

Checks, each failing loudly with the path: non-empty; one paragraph (no line
breaks); at most `maxChars` characters; no run of `ngramWords` consecutive
normalized words shared with the fragment text; and no such run shared with the
whole entity's text, so the gist of one page cannot quote the page before it.
`entityText` is optional inside the drafter loop and **required at index build
and at load for any entity with more than one fragment**; it has one definition,
`entityLintText`: every fragment of the entity in fragment-id order, joined by
blank lines, so the drafter and the loader agree on it whatever order their
fragments arrive in. The function is the only constructor of `LintedGist`.

A failure names the path, the field, and the **position** of the shared run in
the string under test (`quotes the fragment's text at words 3–7`), never the
run itself: the message is what `npm run index`, a CI job, or a consumer's
loader prints, and the run is private text by definition. Both lints throw
`PublicSafeLintError`, so a caller can tell a lint failure (fix the string, or
let the drafter retry) from a malformed file.

Normalization is Unicode-aware (`\p{L}` and `\p{N}`, not `[a-z0-9]`), and for a
script without word spacing the run is counted in characters (a fixed
character-n-gram length, exported) rather than words, because the archive holds
Japanese work and a word-based tripwire would be vacuous on it.

Why these numbers. The 2.x label and locator cap (`PUBLIC_SAFE_MAX_CHARS`, 120)
is a caption; a gist of a page needs two or three sentences, and past about 400
characters a gist has room to retell. Five raw tokens is where legitimate
description ends and quotation begins for prose; four trips on function-word
runs any honest gist shares with its source, and three is unusable. Both
constants are exported, and a different window is **authored on the entity** as
`policy.lint` (`ngramWords`, `ngramChars`, `gistMaxChars`) and stored with it,
so the drafter at build and the validator at load read the same terms;
`ngramWords` and `ngramChars` set the window for the metadata lint on that
entity as well. The recommended practice is to run the lint at four in a dry
run and count the trips before choosing.

**What travels besides the gist, and how it is checked.** On a private entity,
the strings a hit carries that are authored rather than structural are the
entity `title` and `version`, its creators' names and roles, its themes, every
locator value and `end` (a page number is structural and passes trivially; a
`note` or `section` value is authored), the rendered `locatorLabel`, and on each
fragment the speakers' names and roles and the fragment's themes.
`assertPublicSafeMetadata` runs `assertPublicSafeField`'s rule on each of them
against the entity's whole private text (the 2.x check: single line, 120
characters, no five-word run; characters instead of words for a script without
word spacing), at index build and again at every load of a private index. One
exemption: a fragment whose text opens with the entity's title as its own first
paragraph (the note shape, where the private title is embedded with the body)
has that heading removed from the comparison, because the title is the string
under test and publishing it is the author's act; a title that lifts a run from
the body, or from a private title it does not equal, is a quotation and fails.
A second, declared exemption: an entity whose title is public by construction
(a transcript's title is its published episode's) sets `policy.publicTitle:
true`, and the lint then bounds the title (one line, 120 characters) without
checking it against the text, because a host who reads the episode title aloud
has leaked nothing. The declaration is authored, stored on the entity, and
stripped from a served index with the rest of `policy`.
Public entities are not checked: their text is public, so their metadata is
public by construction. The `PublicSafe` return brand is **retired as a type**
in 3.0.0: `title`, `locator`, and `locatorLabel` are shared by public and
private entities, no section 2 type can carry the brand without splitting every
type in two, and the brand erased at JSON anyway. The structural half of
NEXT-STEPS A1 therefore becomes a check named here, run wherever the text is
present, and the brand lives on the one traveling field that is prose, the gist.
Identifiers, dates, ids, types, and URLs are structural and are not linted.

Where the lint runs: at ingest, inside the drafter loop; at index build, over
every gist and every authored string that will be served; at every load of a
private index (section 12: the metadata lint over every private entity, and the
gist lint over every `semantic` fragment's gist, whose `contentHash` must also
be the hash of the text it stands in for), so a hand edit to the artifact is
checked too; and at evaluation, as the canary sweep. Never at query time, and
never on a served index, which has no text left to check against.

## 7. Retrieval

The substrate scores every served fragment against a query vector by cosine
similarity, applies filters before scoring and boosts after it, sorts, floors,
and returns scored hits. What it guarantees is about what a hit may carry, not
whether a hit is relevant. Relevance is tuned by the consumer against its gold
suite.

```ts
export interface RetrievalIndex { entities: Map<string, Entity>; entries: ReadonlyArray<{ fragment: Fragment; vector: readonly number[] }> }
export interface QueryContext { query: string; normalized: string; asOf: Date; recency: 'none' | 'prefer-recent' | 'auto' }
export interface BoostPlugin<P = unknown> {
  name: string;
  prepare?(index: RetrievalIndex, ctx: QueryContext): P;
  score(fragment: Fragment, entity: Entity, ctx: QueryContext, prepared: P): number;
}
export interface PostRank { name: string; apply(ranked: ScoredHit[], ctx: QueryContext): ScoredHit[] }
export interface RetrieveOptions {
  scoreFloor?: number;                                  // default SCORE_FLOOR = 0.2 (teaching corpus); the production consumer passes 0.32
  limit?: number;                                       // total across raw layers; used by the retrieval-only consumer
  limitPerRaw?: { public?: number; private?: number };  // per-layer top-k, default 8 and 8; the 2.x per-stream behaviour the synthesis consumer keeps
  filters?: SearchRequest['filters'];
  recency?: QueryContext['recency'];                    // default 'auto'
  plugins?: BoostPlugin[];                              // default: the built-ins below
  postRank?: PostRank[];
  asOf?: Date;
}
export function retrieve(queryVector: readonly number[], query: string, index: RetrievalIndex, options?: RetrieveOptions): ScoredHit[]
export function partitionByRaw(hits: ScoredHit[]): { public: ScoredHit[]; private: ScoredHit[] }
```

`limit` and `limitPerRaw` are exclusive: a consumer passes one. With `limit`
the result is one ranked list capped at `limit`; with `limitPerRaw` each layer is
ranked and capped separately, so a private hit cannot be crowded out by public
records, which is what the gold suite's route cases rely on today.

Built-in plugins, each with its constant exported: exact title or slug match
(0.30; the slug is the part of `entity.id` after the first `:`); curated theme
named in the query, with a document-frequency cap so a theme carried by more
than 5% of entities boosts nothing (0.15), applied once the corpus is large
enough for a fraction to mean something: a theme is excluded only when its
document frequency exceeds max(4, ceil(5% × entities)), so on eight records a
theme shared by three still boosts; recency, a linear decay from fresh at 180
days to zero at 730 days on `fragment.date ?? entity.date` (0.10); and
disclosure, which favours public fragments and private fragments whose
`sourceReview` is `reviewed` (0.15; this reads the source review, never the
gist's). Each built-in takes a `layers` option naming the raw layers it may
fire on. **The core's default set, used when a consumer passes none, is 2.x's
scoring exactly**: exact match and theme match on public fragments only, so
private fragments ride on cosine alone, which is what keeps the demo's
certified verdicts where they are; the richer set is opt-in. A consumer adds
its own plugins (author aliases, guest speech, distinctive query n-grams, a cap
on hub pages) and removes any of the built-ins. `breakdown` always carries
`cosine` and one entry per plugin that fired.

Recency has three modes because two consumers want two defaults. `auto` fires
the decay only when the query asks about the present, which is the product's
behaviour today; `prefer-recent` always applies it; `none` never does. A
retrieval-only API should default to `none` and let the caller opt in.

Filters run before scoring.

- `type`: entity type in the set.
- Dates. A date string denotes the interval at its precision: `2019` is
  2019-01-01 through 2019-12-31, `2019-03` is the month, `2019-03-14` the day.
  A fragment's effective date is `fragment.date ?? entity.date`. A fragment
  satisfies a bound when its interval intersects the bound's interval. Hits are
  ordered in time by interval start. Undated fragments are excluded whenever a
  bound is present unless `undated: 'include'`, because a hit cannot be shown to
  satisfy a bound it has no date for; the count dropped is returned as
  `excludedUndated`.
- `creator`: case-insensitive name match on the entity's creators. `speaker`:
  the same on the fragment's speakers; a fragment with no speaker data never
  matches, and placeholders never match a name. A caller asking "what did the
  author say, not a guest" uses `speaker`.
- `exposure`, `raw`: as named. A request naming `none` fails validation.

*Retrieved is not cited* applies to hits as it applied to records. A hit is a
candidate. A consumer that synthesizes decides what it cites; a consumer that
returns hits leaves that to its caller. Neither changes what a hit may carry.
In the wire contract's terms (section 8): a hit is a policy-safe retrieval
artifact, not a citation, and `archive-search/1` says nothing about what may
back a claim.

## 8. The wire contract

A retrieval-only consumer returns `SearchResponse`. Every hit in it is a
policy-safe retrieval artifact: what the archive's policy allows to be known
about a relevant fragment. It is not a citation, and nothing in this contract
makes it one; a consumer that writes answers still runs its own grounding gate
over the hits it chooses to cite. The `contract` field is the version;
`archive-search/1` is additive-only. Adding an optional field, a new
identifier or locator scheme, or a new plugin name in `breakdown` does not bump
it. Removing a field, changing a field's meaning, or changing the served
exposure set does, to `archive-search/2`. The fixed copy below is part of the
contract; rewording it is not a bump, changing what it asserts is.

Every hit carries the same provenance regardless of exposure: `raw`; the
entity's id, type, title, creators, date, version, canonical URL, identifiers,
and parent; the fragment's locator and a rendered label; the hit's effective
date, so a caller never coalesces; the fragment's speakers whenever it carries
speaker data; and the score. A caller can therefore order hits in time, separate
what the archive's author said from what a guest said, and link every hit to a
page a person can check, before it reads a word of content.

The fixed copy, normative:

```json
{ "exposure": {
    "text":     "The passage is public and is included verbatim. Quote it with its entity.url.",
    "semantic": "The source is not quotable here. gist is a description of what the passage is about, drafted by the archive's software at ingest and released under the archive owner's policy; gistSource says whether a person edited it and gistReview whether a person reviewed it. It is not a quotation and not the creators' wording.",
    "locator":  "Only the location of relevant material is released. Do not infer its contents." },
  "note": "Nothing in this response was synthesized at request time. Scores on private hits are rounded. Attribution entries with a placeholder are not people: unnamed is a speaker who is not a creator, unverified is attribution not established. Undated material is excluded when a date bound is given unless undated=include." }
```

Three hits, abridged and illustrative. The first is the demo's public-domain
novel, which the demo treats as private to exercise the boundary; its gist is
invented for this page.

```json
{ "fragmentId": "book:wizard-of-oz#ch12", "exposure": "semantic", "raw": "private",
  "entity": { "id": "book:wizard-of-oz", "type": "book", "title": "The Wonderful Wizard of Oz",
    "attribution": [ { "name": "L. Frank Baum", "role": "author" } ], "date": "1900",
    "version": "Project Gutenberg #55", "url": "https://www.gutenberg.org/ebooks/55",
    "identifiers": [ { "scheme": "url", "value": "https://www.gutenberg.org/ebooks/55" } ] },
  "locator": [ { "scheme": "chapter", "value": "12" } ], "locatorLabel": "ch. 12", "date": "1900",
  "gist": "The travellers are sent against a second ruler whose territory is guarded by successive animal armies, and the chapter turns on a borrowed object that compels obedience.",
  "gistSource": "generated", "gistReview": "unreviewed",
  "score": 0.60 }
```

```json
{ "fragmentId": "transcript:perfect-pitch#12", "exposure": "locator", "raw": "private",
  "entity": { "id": "transcript:perfect-pitch", "type": "transcript", "title": "Perfect Pitch: Nature or Nurture?",
    "attribution": [ { "name": "Luke F. Walton", "role": "host" } ], "date": "2022-03-14",
    "url": "https://lukefwalton.com/love-music-more/episodes/perfect-pitch/", "identifiers": [],
    "parent": "episode:perfect-pitch" },
  "locator": [ { "scheme": "timecode", "value": "750", "end": "845" } ], "locatorLabel": "12:30–14:05", "date": "2022-03-14",
  "attribution": [ { "name": "Luke F. Walton", "role": "speaker" }, { "name": "Other", "role": "speaker", "placeholder": "unnamed" } ],
  "score": 0.60 }
```

```json
{ "fragmentId": "song:perfect-pitch#whole", "exposure": "text", "raw": "public",
  "entity": { "id": "song:perfect-pitch", "type": "song", "title": "Perfect Pitch",
    "attribution": [ { "name": "Scoobert Doobert", "role": "performer" } ], "date": "2019",
    "url": "https://lukefwalton.com/songs/perfect-pitch/",
    "identifiers": [ { "scheme": "isrc", "value": "QZ2QB1900012" } ] },
  "locator": [ { "scheme": "whole", "value": "" } ], "locatorLabel": "whole record", "date": "2019",
  "summary": "...", "text": "...",
  "score": 0.98, "breakdown": { "cosine": 0.53, "exactMatch": 0.30, "disclosure": 0.15 } }
```

The transcript is its own entity. Today's production corpus holds, for one
episode, a public record (the episode page) and private transcript windows under
the same slug. Because `raw` is fixed per entity, the windows belong to
`transcript:<slug>` (`raw: 'private'`, `url` the episode page, `parent` the
episode entity, creators shared), and the page stays `episode:<slug>`. A caller
groups them by `parent`.

## 9. The two consumers

Both are outside this package except the teaching-sized reference consumer named
in section 0. The contract says what each may do with a hit.

**Constrained synthesis** (the question-answering product). Hits become
`AnswerEvidence`: a `text` hit is a record in the 2.x sense, quotable evidence
whose body the prompt may render; a `semantic` or `locator` hit is a hint. The
four modes are unchanged, read with that mapping: `supported` cites records and
hints, `partial` cites records only, `related-material` cites hints only,
`not-found` cites nothing and says nothing. **The gist is never rendered into
the prompt.** The prompt shows a `semantic` hit exactly as it shows a `locator`
hit, provenance only; the model chooses citations; and after the mode is final,
the fixed `related-material` template renders the entity's title, creators,
version, the locator label, and the gist. The model never writes prose about
private material in any mode, because in no mode does it see any; the gist is
the only content in the template's sentence, and it arrived through `project()`.

**Retrieval only** (the API and its MCP adapter). The consumer validates a
request, embeds the query once, calls `search()`, and returns `SearchResponse`.
It does not synthesize, does not generate, and does not log query text unless
the operator opts in. Rate limiting is load-bearing for confidentiality, not only
for cost (section 10). The MCP adapter is one tool over the same in-process
function, not over HTTP, with a description that repeats the fixed copy: what the
exposure levels mean, that a gist is a machine-drafted description released by
the owner's policy and not a quotation, that dates and speakers are there to be
used, and that it should run several narrow searches rather than one broad one.

In both consumers, every served string (gist, title, label, name, public text)
is untrusted text to any model that reads it. The substrate bounds its length
and nothing else; a consumer's prompt treats it as data.

## 10. Custody and threat model

The guarantee is disclosure on the served path. What a served object (a hit, an
answer built from hits, a log line that carries a hit, a committed artifact)
can carry is bounded by the policy. Everything else is named here by channel:
what the type closes, what the consumer must do, and what stays owned.

| Channel | The type closes | The consumer must | Owned (section 13) |
|---|---|---|---|
| Source text of a private fragment | no field on `locator`/`semantic` hits | serialize and prompt from `EvidenceHit` only | stepping off the typed path |
| Authored metadata on a private entity (title, version, locator values and label, names, roles, themes) | nothing; one line, 120 characters, and no five-word run with the entity's text, checked at build and at every load of a private index (section 6) | build and load the private index through this package; keep a served index downstream of a validated private one | a short private phrase; private meaning in public words (A1's residue) |
| A gist for a fragment whose policy is `locator`/`none` | `isServableGist` and the served-index strip | validate the served index at load | mislabelled layers |
| Private vectors | not committed; not on the wire | rate-limit; coarse scores on private hits; omit model and dimensions from responses | inversion of a vector an attacker already holds |
| Score oracle (per-query cosine on a private vector) | scores rounded, `breakdown` omitted on private hits | rate-limit; cache | residual coarse signal per query |
| Provider custody at ingest | nothing | choose the provider; check its data-use terms | retention by the provider |
| Query text | nothing | no query logging by default; the query also reaches the embedding provider at request time | caller privacy is the consumer's |
| Composition of gists | nothing | set policy per entity; veto; review | over-description |
| Served strings as prompt input | length bounds | treat as data in any prompt | prompt injection through source text |

Three of those rows deserve a sentence.

- **Provider custody.** Private text leaves the operator's machine for the
  embedding provider today, and under this contract also for the gist drafter,
  and only for fragments whose author asked for a gist. The drafter is called
  through the Responses API with `store: false`. The embeddings endpoint has no
  per-request retention switch; what the provider keeps from that call is
  governed by its API data-use terms or an account-level retention arrangement,
  which is the operator's to check and not this package's to assert. The boundary
  is disclosure on the served path, not confidentiality from the providers the
  operator chooses.
- **Mislabelled layers.** A private text ingested with `raw: 'public'` defeats
  the boundary. Layer assignment is an authored act upstream of the type; the
  type enforces downstream of it.
- **Enumeration.** A caller that issues many queries can collect every served
  gist of an entity and the composed set says more than any one gist. The set is
  finite and released one policy at a time; the composition is not lint-checked
  and is owned by the entity policy, the veto, and review. A consumer should say
  so on its documentation page.

## 11. Evaluation

The gold suite remains the admission gate for every change, and the contract
extends what it gates. An exposure change on an entity is a change like a scoring
change: it is admitted or rejected by the suite, never by intuition. Three
additions:

1. **A canary sweep over served gists.** Leakage canaries, distinctive phrases
   from private text that must never appear in output, are checked against
   every gist a served index would release, not only the gists a gold query
   retrieves, because a retrieval-only consumer can surface any of them; and,
   per entity, against the concatenation of its gists, so composition is at
   least watched. The sweep includes at least one canary in a script without
   word spacing.
2. **Fragment ids in expected sources.** A gold query may require a specific
   fragment, not only a specific entity, so routing to the right page or window
   is testable.
3. **Short verbatim runs are canaries, not lint.** A name, a number, or a
   two-word phrase from private text is shorter than the lint's run and passes
   it. The canary set is where such phrases are caught, and the names rule is
   enforced by the drafter's prompt and the canaries, not by the lint.

The rule that comes with the suite does not change: a failing query is fixed in
the corpus, the scoring, the prompt, or the policy, never by special-casing the
question.

## 12. Index schema and migration

The private index file becomes schema 4: `{ version: 4, entities: Entity[],
entries: [{ model, dimensions, vector, contentHash, fragment: Fragment }] }`.
Entities are stored once; fragments reference them by id. A schema-3 index fails
fast with the rebuild instruction, as a schema-2 one does today. The served
index is the same shape after `toServedIndex`.

Validation at load checks, on every index: every entity and every entry is
well formed down to its nested items (attribution, identifiers, locators,
projection, policy) and its vector (exactly `dimensions` finite numbers), and a
failure names the field, never a value; every entity and every fragment id is
listed once; every fragment's entity resolves; every entity has at least one
fragment; `fragment.disclosure.raw` equals its entity's `raw`; the disclosure
is a legal cell; a `semantic` fragment satisfies `isServableGist`. On a private
index it
also re-earns, against the text it still holds, the two verdicts a served hit
relies on rather than reading them from the file: the section 6 metadata lint
runs over every private entity against that entity's text, heading exemption
included, so an authored string that quotes the text fails at load with the
field and the position of the run; and every `semantic` fragment's gist must
carry the `contentHash` of the fragment's text and pass the section 6 gist lint
against that text, and against the whole entity's text where there is more than
one fragment, under the entity's `policy.lint` window, exactly as the drafter
checked it. `lint: 'passed'` in the file is a word, not a verdict. A projection
carried on a fragment not exposed as `semantic` is private material that never
travels and is not re-checked until a build makes it servable. On a served
index it instead checks rule 4: no fragment has exposure `none`; `text` and
`summary` are `''` wherever exposure is not `text`; `projection` is absent
wherever exposure is not `semantic`; no `contentHash`, `policy`, or
`sourceReview` remains. Neither lint can run on a served index (the text is
blank) and neither is pretended to. A served index that fails these was misbuilt
and is refused with the rebuild instruction. `writeIndex` and
`writeServedIndex` run the same validation before writing, so what the next
load would refuse is refused at build.

Each entry's vector and `contentHash` are taken over the fragment's **embed
string**, one rule in `src/embed-string.ts` chosen so that today's bytes are
reproduced: a public `text` fragment embeds its entity's title, its summary, a
`Themes: ...` line, and its text (today's `embedText` for a record); every other
fragment embeds its text alone (today's `noteEmbedText`, where the private title
is already inside `text`). Changing the rule is a re-embed of the corpus.
`fromArchiveRecord` sets `fragment.text` to the body and copies `summary`;
`fromPrivateNote` sets `fragment.text` to the note's private title and body
joined by a blank line, so the private title stays in the embedding and never
leaves `text`. A pure, keyless migration (`npm run migrate:index`,
`migrateV3ToV4` in `src/store.ts`) re-keys a schema-3 file without re-embedding;
the demo's committed `demo/corpus/*.json` were migrated with it, as the 2→3
migration did, and `demo/artifacts.test.ts` keeps the hash derivation it pins.
Until the retrieval core reads fragments, `readIndexFile` and `writeIndexFile`
keep their 2.x record/note signatures and translate through the adapters (a
transitional view, lossless for anything the adapters wrote), so the file format
moved first and every caller stayed green.

The teaching corpus keeps working through the adapters. `fromArchiveRecord`
yields an entity with one `text` fragment whose locator is `[{ scheme: 'whole',
value: '' }]`; `fromPrivateNote` yields a private entity with one `locator`
fragment whose linted label becomes the entity title and whose locator string
becomes `[{ scheme: 'note', value }]`, and whose frontmatter may ask for an
`exposure`. `fromPrivateBook` yields a private entity with one fragment per
piece the corpus reader cut (`buildPrivateBooks`: `fragmentByHeadings` or
`fragmentByPageMarkers`, then `splitLong`), ids `${entityId}#${locatorKey}`,
each fragment's text its heading and its piece joined as a note's title and
body are, the frontmatter's `publicTitle` and `requireReview` on the entity's
`policy`, and the section 6 metadata lint run over the whole book before the
build drafts or embeds anything; `collectEntities` then groups the pairs, comparing
two descriptions of one entity by content with keys sorted at every level, not
by property order. The example content does not change. The demo gains one
entity that exercises `semantic` in a following release: a public-domain novel
with its chapter gists committed beside the vectors, which needs a keyed build.

## 13. What remains owned rather than guaranteed

Named here so they are not discovered. Each is owned by a person and a policy,
not by the type.

- Paraphrase, plot, and meaning carried in public words pass the lint.
- A verbatim run shorter than the lint's window, including a name or a number,
  passes the lint; the canaries are where it is caught.
- A generated gist can describe more than the author intended, and an entity's
  gists compose.
- A coarse score on a private hit is still a signal per query; rate limiting is
  what bounds how many signals a caller gets.
- Layer assignment, the choice of `raw`, is authored upstream of the type.
- The brand erases at JSON boundaries. A private index is re-linted at every
  load, authored strings and served gists both, because it still holds the
  text; a served index is trusted to have been
  built through the gate from a validated private one, and its load-time
  validator checks the shape and the strip, not the provenance, of what it loads.
- Recall. A fragment below the floor is absent, and absence is what a gate cannot
  catch.
- Provider custody at ingest.

## 14. Three questions a reviewer of the 2.x design asks

- **What does "private" defend against?** Disclosure on the served path, and
  nothing else. Section 10 says what the type closes, what the consumer must do,
  and what stays owned, channel by channel, including embedding-time custody,
  inversion, and the score oracle that a retrieval-only wire opens and this
  contract closes by rounding.
- **Can the model fabricate the contents of private material and cite it?**
  2.x closed this for the related-material mode by templating that mode's prose
  from a hint's public fields. Under this contract the gist never enters the
  prompt in any mode, so the closure holds for `supported` and `partial` as well:
  the model has no description of the private material to restate. The gist
  itself is lint-gated and policy-released, and travels with its own provenance.
- **Does `partial` read backwards?** The mode names are kept because the
  consumer's gold suite pins them. The rationale stands as before: in an archive
  whose centre is the private moment, an answer that cannot route to one is
  partial relative to the corpus's own structure. Renaming is the author's call
  and would be a consumer change, not a substrate one.

## 15. What stays out of this package

HTTP handlers, rate limits, caches, and CDN behaviour; the MCP transport;
transcription and any site-specific corpus builder; product routes that answer
without a model; a site's own boosts; a production synthesis service. Each
belongs to a consumer. The teaching-sized reference consumer stays, as the thing
the full tier of the gold suite exercises. The substrate's job is to make sure
that whatever a consumer builds, the object it builds from cannot carry more
than the archive's author released.
