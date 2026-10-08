---
title: 'Answer Engine: a disclosure-typed retrieval substrate for an author-owned archive'
tags:
  - TypeScript
  - retrieval-augmented generation
  - information disclosure
  - provenance
  - citation grounding
  - Model Context Protocol
authors:
  - name: Luke F. Walton
    orcid: 0009-0005-9263-1954
    affiliation: 1
affiliations:
  - name: Independent Researcher
    index: 1
date: 7 October 2026
bibliography: paper.bib
---

# Summary

`answer-engine` is a small TypeScript package for searching a body of work its author owns, some of it published and some not, and for handing the results to a language model or an external caller without any text of the unpublished part leaving the server. The frame has an owner by premise: the author decides what enters the archive, how much of each piece may travel, and when the system declines, and the software keeps those decisions in force where a model would infer past them. Every retrievable fragment carries a disclosure policy, resolved and stored before any query: which layer its text is in (`public` or `private`) and how much of it may travel (`text`; a short `semantic` description the author released; a `locator` that says only where the moment is; or `none`). One function, `project()`, is the single crossing from retrieval to the wire type a consumer may serialize or prompt from, a union whose private variants have no field for a fragment's text; `private + text` is not a member of the policy type, so the compiler refuses it in code and the index validator refuses it in data. A private fragment can therefore still do work: it is found, it returns as a locator or an authorized description, and every hit carries provenance (creators, date, identifiers, locator) a caller can cite with no synthesis on the server. The package provides the contract types, ingest, retrieval, both index formats, a reference consumer that cites or refuses, and an evaluation harness that gates every change. Tests and demo run keyless; the package is on npm and in production.

# Statement of need

Retrieval-augmented generation [@lewis2020; @gao2023] assumes that what retrieval returns may be shown to the model, and the Model Context Protocol [@mcp2026] now lets a model the operator does not control call a search tool directly. For an author's archive it is often false: an unpublished podcast transcript, a manuscript under contract, a notebook. The operator could exclude such material, filter or redact what comes back, or trust a prompt. The first two decide whether a chunk may be seen at all; neither lets a private fragment contribute to an answer by being found, located, and described while none of its text travels. The third is a promise made to the model, not a property of the data.

The research question the software tests is whether that disclosure can be made a property of the data: fixed per fragment before any query, carried on the wire as the only representation a consumer can receive, and unrepresentable in the type when forbidden. The question comes from work on answerability in generative systems [@walton2026a; @walton2026b; @walton2026c; @walton2026d], Shoemaker's standing to be asked for the judgment behind an act [@shoemaker2011]: the frame a system acts under must have an owner who can be reached [@walton2026b], and an operation no one answers for should be unavailable as an ordinary operation of the system [@walton2026d]. What may travel about a retrieved private fragment is one such operation. `answer-engine` is that argument's materials, the runnable link between its design theory and a live deployment, offered to the conversation on selective disclosure in retrieval-augmented systems.

# State of the field

Retrieval frameworks such as LangChain [@langchain] and LlamaIndex [@llamaindex] return chunks with free-form metadata and leave what may be shown to the model to the application; their access controls decide which whole chunks a caller may retrieve. Attributed and verifiable generation [@bohnet2022; @rashkin2023; @liu2023] measures whether an answer is supported by its citations after the fact, and runtime guardrails [@rebedea2023] filter inputs and outputs with programmable rules.

Two recent lines of work come closest. SD-RAG [@almasoud2026] shares the aim, selective disclosure in retrieval-augmented generation, and the move of taking the decision away from the answering model: it carries constraints in the data model and sanitizes retrieved material before it reaches the generator. MNC [@xu2026] shares the vocabulary: a typed semantic-declassification protocol between agents that selects a task-sufficient disclosure from supplied candidates and binds it to recipient, purpose, and lifetime under a reference monitor; it governs what an agent may say onward, per message, not how a retrieval result is represented. Nearby, @rasul2026 add an information-flow monitor to a retrieval-augmented chatbot's serving path, and @siddiqui2025 propagate confidentiality labels through a model's output. In each, the permitted representation of a retrieved item is computed in response to the query, by a filter, a monitor, or a model, from text present at that moment. Here it is fixed before any query, nothing is generated in response to one, and the served artifact holds nothing else. The older lineage is language-based information-flow control [@goguen1982; @sabelfeld2003], where a forbidden flow is made inexpressible rather than filtered; the package borrows that move for the form of a hit, and only there. To the author's knowledge, no retrieval package combines these concerns in a disclosure-typed retrieval contract: one representation per fragment fixed before any query, forbidden representations uninhabitable in the consumer-facing type, and the drafting of a released description separated from the authority to release it.

# Software design

`docs/CONTRACT.md` is the design of record. An **entity** (a song, a transcript, a book) declares a default disclosure; its **fragments** (a chapter, a transcript window) may narrow the exposure but never change the layer. Disclosure is resolved at build time by a function that only downgrades: a requested `semantic` becomes `locator` when its description is missing, failed the lint, was vetoed, went stale, or awaits a required review.

**One crossing.** `retrieve()` returns scored fragments to the process that holds the index; `project()` is the only path from them to `EvidenceHit`, a discriminated union on `exposure` whose `locator` variant carries provenance and nothing else and whose `semantic` variant carries a branded `LintedGist` only the lint can construct. The private index's validator refuses `private + text` in data, where types do not reach. Scores on private hits are rounded and carry no per-plugin breakdown, because a full-precision similarity against a private vector is a measurement of it. The type fixes the form of a hit; what a sequence of hits reveals (which fragment answered, and roughly how well) is a residue the contract names and assigns to the consumer's rate limiting and the author's policy, `none` included.

**Authorship and authorization are separate.** A description is drafted by a model at ingest, stored beside the index as private material, and released only by the entity's policy, a per-fragment override, or the author's edit, veto, or review. Release by policy authorizes a class of machine drafts the author need not have read; release by edit or review authorizes text the author has seen. The build-time lint is a tripwire, not a classifier: it refuses any run of five words shared with the fragment or its whole entity and catches nothing shorter. Close paraphrase, names, and spoilers are owned by policy, veto, and the evaluation's canaries.

**Two artifacts, one validator.** The private index holds text and vectors and re-earns every lint at each load; the served index is the same file after a strip that blanks text and drops every projection a policy did not release, and a load-time check verifies the strip. The lint cannot run where the text is blank, so a served index is trusted to descend from a validated private one. In deployment the strip keeps text off the wire; the type states and checks the contract and binds a consumer holding the private index.

**A refusal is a disciplined non-assertion.** `not-found` says the archive authorized no answer, and `related-material` says evidence exists and may only be pointed to; neither claims the matter is unknowable.

**Evaluation is the admission gate.** A fixed gold set with required behaviours (answer, route to private material without quoting it, refuse) runs keyless at the retrieval tier, and a canary sweep checks every served gist against private phrases the author lists, so an exposure change is gated like a scoring change.

HTTP, transport, and site-specific ranking live in consumers.

# Research impact statement

The package is the substrate under Ask the Archive (lukefwalton.com/ask), a production deployment over the author's archive of roughly ten thousand embedded fragments, where published passages are public and unpublished transcript text is private: embedded for search, served as where to listen, never as the text itself. The same deployment exposes a rate-limited retrieval-only endpoint and an MCP server through which an external model receives hits at the exposure the author set, and it carries an unpublished novel as a private entity whose chapters are served as locators. The `semantic` exposure is exercised by the package's tests and demo and reaches the deployment only as a policy change and a rebuild. A gold suite of 311 queries, 28 of which must refuse, every row carrying hard-fail guards against leakage and misattribution, gates every change to that deployment. The software is cited as the materials of the answerability working paper [@walton2026d], documented in a technical note [@walton2026note], and archived under a concept DOI [@walton2026software]. What it shows is the feasibility of one architectural claim in those papers: that a class of normative juncture, here what may travel about a retrieved private fragment, can be moved out of model behaviour into representable operations. It does not bear on the working paper's empirical claim about how correction compounds into capability, which that paper leaves unmeasured. No use by other research groups is claimed.

# AI usage disclosure

Generative AI was used in the software and in this paper. Of the 169 commits on the default branch at the time of writing, 69 are authored as Claude (Claude Code, with Claude Opus 4.8, Claude Fable 5, and Claude Fable 5.1, Anthropic), working from the author's written specifications; every change was reviewed in a pull request, with an automated review (Surmado Code Review), an offline test suite, and the gold evaluation as the admission gate. Documentation and this paper were drafted with the same tools under the author's direction and edited by the author. OpenAI models are runtime components of the software (`text-embedding-3-large` for embedding; a Responses API model for gist drafting and for the reference consumer's synthesis); no evaluation result reported here was generated by an AI system. The author reviewed, edited, and validated all AI-assisted output and is responsible for it.

# Acknowledgements

This work received no funding. The author is the founder of Surmado, Inc., which builds managed AI systems of the kind this software describes; the paper is written in a personal capacity.

# References
