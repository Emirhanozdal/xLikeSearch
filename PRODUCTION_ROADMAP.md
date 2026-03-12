# Product Audit and Build Order

This project is now beyond MVP. The next problem is not "can it work?" The next problem is "can it be trusted, fast, and useful every day?"

The current product has real strengths:

- local-first storage
- working archive import paths
- automatic visible sync
- network-first archive import attempt with DOM fallback
- lexical + semantic retrieval foundation
- quote / repost-aware data model

The current product also has real weaknesses:

- importer correctness is not proven yet
- network importer still needs tighter request filtering and page-shape validation
- category quality is weak
- semantic state is technically present but product quality is low
- ranking is still basic
- export and archive portability do not exist yet
- panel is more usable now, but still too diagnostic-heavy for normal use

This document is the build order for turning the project into a real product.

## Current State

### What is working

- X likes can be captured into IndexedDB
- visible sync can run without scroll
- archive import now prefers network capture over raw DOM scrolling
- fallback importer still exists if network path fails
- basic semantic indexing can run locally
- compact / deep storage mode exists

### What is not good enough

- like counts can still drift if the network parser accepts the wrong timeline entries
- current category assignment overuses `uncategorized`
- semantic indexing progress and quality are not strong enough to be a product promise
- ranking does not yet reflect multiple user intents
- no export path means the archive is trapped inside the extension
- no user-facing archive freshness / confidence model exists

## Product Priorities

### Priority 1: Import Correctness

Goal: trust the count.

Needed work:

- tighten network timeline parsing to only accept actual liked timeline entries
- add parser confidence checks:
  - repeated cursor detection
  - duplicate ratio
  - suspicious overcount warning
  - suspicious undercount warning
- track import source explicitly:
  - visible sync
  - recent sync
  - network archive
  - DOM fallback archive
- add import summary after each job:
  - new likes imported
  - duplicate count
  - source used
  - completion confidence

Success criteria:

- imported counts should stay near the user's actual like count
- archive import should not silently overcount quoted or nested tweets
- fallback usage should be visible to the user

### Priority 2: Retrieval Quality

Goal: find the right tweet fast, even from vague memory.

Needed work:

- improve lexical ranking by weighting:
  - tweet text
  - quoted text
  - author
  - handle
  - social context
  - keyword overlap
- add more ranking modes:
  - relevance
  - newest
  - oldest
  - most recently captured
  - author
  - category density
- add better semantic fallback rules:
  - if semantic coverage is low, degrade gracefully to lexical-first ranking
- add query parsing:
  - exact phrase
  - author filter
  - category filter
  - negative term

Success criteria:

- exact keyword search feels precise
- vague concept search is still useful
- result ordering is explainable

### Priority 3: Categorization Intelligence

Goal: categories become useful, not cosmetic.

Needed work:

- strengthen rule-based topic coverage
- split categories into:
  - AI topics
  - product/business topics
  - design topics
  - engineering topics
- add multi-label confidence scoring instead of one-pass substring hits
- add lightweight local topic enrichment:
  - keyword bundles
  - author priors
  - quoted-text contribution
- add manual override support later:
  - add / remove category
  - pin category

Recommended AI direction:

- do not jump to a generator first
- first add a small local classification layer on top of retrieval text features
- only after that add "ask my likes"

Success criteria:

- `uncategorized` rate falls sharply
- top categories reflect real archive themes
- category filters improve retrieval

### Priority 4: UX and Product Structure

Goal: everyday use should feel automatic and calm.

Needed work:

- make panel open into a normal user mode first:
  - search
  - top results
  - sync status
- move diagnostics into a collapsible section
- show sync lifecycle clearly:
  - syncing
  - completed
  - using network importer
  - using fallback importer
  - stale
- add archive freshness language:
  - synced just now
  - synced 2 hours ago
  - archive may be stale
- remove debug-heavy messaging from primary surface

Success criteria:

- user does not need to understand importer internals
- status is visible without being noisy
- panel feels like a tool, not a prototype

## Sorting Features

These should be added as first-class product controls.

### V1 sorting

- relevance
- newest tweet
- oldest tweet
- newest captured
- oldest captured

### V2 sorting

- author A-Z
- author frequency
- category match strength
- semantic score
- lexical score

### V3 advanced ranking

- hybrid weighted ranking profiles:
  - strict keyword
  - balanced
  - exploratory

Implementation note:

- keep the default on `relevance`
- persist the user's chosen sort locally
- show the active sort near result count

## Export Features

This is mandatory. A personal archive without export is incomplete.

### V1 export

- export current result set as JSON
- export full archive as JSON
- export current result set as CSV
- export full archive as CSV

### V2 export

- export by filter:
  - category
  - author
  - date range
  - current query
- include quoted tweet text and social context fields

### V3 archive portability

- full archive package export:
  - likes
  - metadata
  - categories
  - keywords
  - optional embeddings manifest
- re-import exported archive into the extension

Implementation note:

- JSON should be the canonical export
- CSV is for spreadsheets and analysis
- do not export raw media blobs

## AI Roadmap

The AI layer should be built in this order.

### AI Phase 1: Better local retrieval

- stronger lexical weighting
- semantic rerank only on candidate pool
- semantic completeness awareness
- ranking explanation signals

### AI Phase 2: Topic intelligence

- local topic scoring
- better category confidence
- automatic archive theme summaries

### AI Phase 3: Ask My Likes

- natural-language question mode
- retrieve relevant liked tweets
- answer with citations to liked tweets
- never answer from thin air if retrieval is weak

### AI Phase 4: Personal archive workflows

- "show me what I liked about X last month"
- "group my likes by idea cluster"
- "resurface overlooked saved ideas"

## Recommended Execution Order

1. importer correctness and count validation
2. result sorting controls
3. export V1
4. category quality improvements
5. retrieval ranking overhaul
6. diagnostics collapse + cleaner main UX
7. AI Phase 1 retrieval improvements
8. AI Phase 2 topic intelligence
9. Ask My Likes

## Immediate Next Tasks

These are the highest-value near-term implementation tasks.

1. Fix overcount risk in network importer and add completion confidence
2. Add result sort control to the side panel
3. Add JSON / CSV export for current results and full archive
4. Move diagnostics under a collapsible panel
5. Reduce `uncategorized` rate with better topic rules and confidence
6. Add hybrid ranking modes and fallback behavior when semantic coverage is low

## Non-Goals Right Now

- cloud sync
- remote vector database
- team collaboration
- media blob storage
- fine-tuning custom LLMs
