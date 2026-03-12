# Backend Architecture Direction

This note captures the next architectural direction for `xLikeSearch`.

The extension-only approach is good for prototyping and for a privacy-first local mode, but the product is now reaching the point where the AI and retrieval layers are cleaner as a backend service.

## Goal

Keep the extension focused on:

- collecting liked tweets from X
- showing sync status
- providing the main user interface
- exporting local data when needed

Move the heavy AI and retrieval work to a Python backend:

- embedding generation
- lexical indexing
- vector indexing
- hybrid retrieval
- answer generation for `Ask my likes`
- ingestion telemetry and debugging

## Recommended Split

### Extension responsibilities

- capture X likes from page/network
- batch and send normalized tweet payloads
- keep lightweight local cache for fast UI
- show sync/import progress
- show search and answer results
- keep export controls

### Backend responsibilities

- normalize and deduplicate tweets
- store authors, tweets, likes, and embeddings
- compute embeddings
- maintain BM25/full-text and vector retrieval
- run hybrid ranking
- generate grounded answers with citations
- expose debug and ingest status endpoints

## Why This Direction

The current browser-first setup has real limits:

- model download and runtime issues in extension context
- WebGPU / WASM environment instability
- weak observability
- difficult debugging around ingestion and ranking
- semantic/search quality tightly coupled to browser lifecycle

A backend gives:

- better observability
- easier iteration on retrieval quality
- stronger answer generation
- easier logging and diagnostics
- more stable embedding pipeline

## Proposed Backend Stack

- `FastAPI`
- `Postgres`
- `pgvector`
- `tsvector` / Postgres full-text search for lexical ranking
- `sentence-transformers` or similar embedding model
- optional queue worker for embeddings and answer tasks

## Core API

### `POST /ingest/likes`

Purpose:

- receive liked tweet batches from the extension
- normalize and deduplicate
- enqueue embeddings

Expected payload:

- user identifier or installation identifier
- source metadata
- tweet batch

Response:

- ingest job id
- accepted count
- duplicate count
- queued count

### `POST /search`

Purpose:

- run BM25 + semantic hybrid retrieval

Expected payload:

- query text
- category filters
- author filters
- date filters
- sort mode

Response:

- results
- bm25 score
- semantic score
- final score
- why matched

### `POST /ask`

Purpose:

- retrieve top matches
- generate grounded answer with citations

Expected payload:

- natural language question
- optional structured filters

Response:

- answer
- citations
- retrieval metadata
- answer source / model
- latency

### `GET /sync/status`

Purpose:

- show ingestion progress to the extension

Response:

- latest ingest state
- queued embeddings
- last completed sync

### `GET /debug/ingest/{job_id}`

Purpose:

- inspect what happened during a specific import

Response:

- raw counts
- duplicate ratio
- parse warnings
- stored tweet ids
- failure reasons if any

## Proposed Data Model

### `authors`

- `id`
- `handle`
- `name`

### `tweets`

- `id`
- `canonical_id`
- `author_id`
- `text`
- `created_at`
- `url`
- `quoted_tweet_id`
- `social_context_type`
- `captured_at`

### `likes`

- `id`
- `user_id`
- `tweet_id`
- `source`
- `captured_at`

### `tweet_embeddings`

- `tweet_id`
- `model`
- `embedding`
- `updated_at`

### `ingest_jobs`

- `id`
- `user_id`
- `status`
- `source`
- `accepted_count`
- `duplicate_count`
- `error_count`
- `started_at`
- `finished_at`

### `query_logs`

- `id`
- `user_id`
- `query`
- `filters`
- `latency_ms`
- `top_result_ids`
- `created_at`

## Retrieval Pipeline

### Search

1. normalize query
2. parse author/date/category filters
3. run lexical retrieval
4. run semantic retrieval
5. merge scores with weighted ranking
6. return results with score breakdown and reasons

### Ask

1. parse question
2. retrieve top-k evidence
3. build citation pack
4. run answer model
5. return grounded answer with citations

## Observability Requirements

This is one of the main reasons to move backend-side.

We want:

- ingest logs
- duplicate counts
- parse warnings
- embedding queue status
- retrieval score breakdown
- answer trace
- model latency

Without this, it is difficult to improve product quality.

## Product Direction

Short term:

- extension remains the collection and UI layer
- backend becomes the retrieval and answer layer

Medium term:

- local mode can stay as an optional fallback
- backend mode becomes the main product path

## Immediate Next Step

Build a minimal backend that supports:

1. `POST /ingest/likes`
2. `POST /search`
3. `POST /ask`
4. `GET /sync/status`

Then wire the extension to talk to this backend behind a feature flag.
