# Historical draft: the scaling-demo corpus

This file is the original corpus-manifest draft kept with the planning notes.
The live, verified manifest is `demo/corpus/README.md`; it owns the build-run
provenance, source IDs, dates, and ARK adjudication.

This folder holds the corpus for the int8 scaling demo. This README is the corpus's **answerable half**: the mechanism makes the unauthored move inexpressible; this document owns, in the open, every authored choice behind the data. Each entry names the choice and the reason it was made. None of it is hidden, so none of it is a concession; it is the record of decisions a maintainer signs for.

If you are reading this to attack the corpus, the choices you would reach for are below, named first.

## What this corpus is

A name-collision corpus over two real, public-domain authors who share a name:

- **Adam Smith**, the economist and moral philosopher (1723–1790).
- **George Adam Smith**, the theologian and historical geographer (1856–1942). ("Adam" is a middle name; the partial-name match is deliberate, see the boost edge case in the gold suite.)

Both write dense moral prose about justice, society, and ethics, so the two bodies of work sit close in embedding space. That proximity, not corpus size, is the point: it packs the near-ties where int8 rounding can reorder candidates, which is the only condition under which the demo tests anything.

## Provenance and public-domain status

Every source, with the basis for its public-domain status. Public domain is the *absence* of copyright, not a license — this corpus is not "permissively licensed," it is public-domain. State the basis in both jurisdictions cleanly, since they rest on different facts:
- **US:** published before 1931, so public domain in the USA. (As of 1 Jan 2026, works published in 1930 and earlier are PD in the US.)
- **Life-plus-70 jurisdictions:** public domain once the author has been dead 70 years. In 2026 that covers authors who died in 1955 or earlier; George Adam Smith died 1942 and Adam Smith in 1790, so both are clear.

Draft rows below were placeholders to verify during the build. Do not cite this
table as the live provenance record; use `demo/corpus/README.md`.

| Work (unit) | Author | Pub. | Layer | Source (ID) | PD basis | Notes |
|---|---|---|---|---|---|---|
| _Theory of Moral Sentiments_, §\<n\> | Adam Smith | 1759 | public | Gutenberg \<id\> | US: pre-1931 / PD in USA. Life+70: author d. 1790; term expired | _fill: clean / OCR-noisy_ |
| _Wealth of Nations_, bk\<n\> ch\<n\> | Adam Smith | 1776 | public | Gutenberg \<id\> | US: pre-1931 / PD in USA. Life+70: author d. 1790; term expired | |
| _The Book of the Twelve Prophets_, \<prophet\> | George Adam Smith | 1896–98 | public | Gutenberg 43847 / 50747 | US: pre-1931 / PD in USA. Life+70: author d. 1942; term expired | confirmed on Gutenberg |
| _The Book of Isaiah_, ch\<n\> | George Adam Smith | 1888–90 | public | Gutenberg 39767 / 43672 | US: pre-1931 / PD in USA. Life+70: author d. 1942; term expired | confirmed on Gutenberg |
| _The Forgiveness of Sins, and Other Sermons_, \<sermon\> | George Adam Smith | 1905 (A. C. Armstrong & Son) | **private** | Internet Archive `forgivenessofsin00smitrich` (ARK `ark:/13960/t0gt5jk4g`); HathiTrust full-view backup record 100136688 | US: pre-1931 / PD in USA. Life+70: author d. 1942; term expired | **confirmed.** IA marks NOT_IN_COPYRIGHT; Commons mirrors as PD-US; IA offers full-text/OCR + PDF. OCR-noisy, which is fine |
| \<edge-case note\> | — (fabricated) | — | **synthetic** | authored here | n/a (no copyright in fabricated demo text) | `synthetic: true`; tests \<gold id\> |

**Sourcing (resolved).** George's *major* commentaries are confirmed on Project Gutenberg. The private layer rests on *The Forgiveness of Sins, and other Sermons* (1905), confirmed as a full public-domain scan on archive.org (`forgivenessofsin00smitrich`) — a single volume yielding several short, windy sermon units, which is exactly what the private layer needs. *Jeremiah: Being the Baird Lecture for 1922* (1923) is available as a further minor source if wanted. The fallback (designating a section of a major work private) is therefore **not** required; if a future rebuild loses these sources, that fallback keeps the private layer real rather than padding it with synthetic.

## The authored choices (named first, owned in the open)

**1. The corpus is partly fabricated, and the claim does not depend on its realism.** The public layer (both Smiths) is real public-domain text the maintainer did not write. The private layer is real George minor works. The synthetic notes are a small, flagged set (below). The demo's claim is *relative* — int8 preserves the verdicts full-precision produces, and where it does not, the gate catches it. Realism is never asserted; the baseline runs on text the maintainer does not control.

**2. "Private" is a layer assignment, not a claim of secrecy.** George was a public figure and all his work is published; designating some of it private means only that *the type cannot carry its text to the model*, regardless of what the text is. The whole repo works this way (the default example corpus is synthetic "Person A"). Everything here is exposed in the repo on purpose: seeing the full private text, then watching the type admit only its routing hint, is the demonstration, not a contradiction of it. **This is also why this demo can commit its embedding vectors when the main repo gitignores its index: these vectors derive from public-domain text, so they expose nothing already private. Do not copy "commit your vectors" as a general pattern — embeddings of genuinely private text can be inverted to recover approximate content, which is the exposure the main repo's gitignored index avoids.**

**3. No fabricated words are attributed to the real Adam Smith, and synthetic notes are flagged in the data.** Every fabricated note carries `synthetic: true` (or lives in a quarantined file) and names the edge case it tests, so nothing can be mistaken for either Smith's actual writing even lifted out of context. Real George material is handled as George's; synthetic is never confusable with it.

**4. The corpus is not tuned so int8 passes.** Headline numbers come from the real-only run. The demo deliberately *includes a failure*: a tightened encoding (int4, or a lowered floor) breaking a route case, caught by the gold suite. Shipping a caught failure is the opposite of tuning to pass; it is how the demo shows the gate can say no.

**5. Themes are authored honestly, including where they collide.** Both Smiths carry shared themes (e.g. "justice"), so a verbatim theme match can hand the boost to the wrong Smith. That mis-fire is a near-tie the gold suite *exposes*, not one smoothed away by curation. Themes are not shaped to make disambiguation easy; doing so would special-case the corpus, which the eval forbids.

**6. The public/private split is a research decision, stated as one.** Major, legible George works go to the public records layer; minor, windy works go to the private routing layer. This is an authored, answerable choice made to exercise both the disambiguation path (public) and the routing path (private) without confounding them, not a natural fact about the texts.

**7. The synthetic layer is a spire, not a column.** It is deliberately small. A large synthetic layer would invert the honesty of the demo (headline numbers riding on authored text) and would mean a large body of fabricated words attributed to a real person, in a project about provenance and backing. If more near-ties are ever needed, the lever is a tighter floor and boosts (a calibration question, gold-gated), not more fabricated text.

## Scope of this README

This file documents the **data and the choices behind it** only. The mechanism (the type boundary, retrieval, the modes), the eval, and the int8 harness are documented where they live; this is not the place to restate them. Provenance and authored choices here; everything else by reference.
