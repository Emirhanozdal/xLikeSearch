# xLikeSearch

`xLikeSearch` is a Chrome extension that turns X likes into a local archive with search, semantic retrieval, export, and a side panel workflow.

The product direction is simple:

- import liked tweets without making the user manually manage the process
- keep the archive local-first
- make vague memory searchable
- layer answer generation on top of retrieval instead of faking a chat product

## Current State

What works today:

- network-first likes import from X timeline requests
- DOM fallback importer when network capture fails
- automatic visible sync on the likes page
- local archive storage in IndexedDB
- keyword search and semantic retrieval
- export as JSON and CSV
- `Ask my likes` answer layer with citations
- background import tab flow

What is still in progress:

- importer confidence and count validation
- better category quality and lower `uncategorized` rate
- stronger RAG-style answer formatting and filtering
- saved views and collection workflows

## Product Architecture

The extension is split into four main layers.

### 1. Import Layer

- `content script` reads visible tweets and manages fallback page import
- `page bridge` runs in page context and captures X GraphQL timeline traffic
- `background service worker` orchestrates worker tabs, import state, and telemetry

### 2. Archive Layer

- likes are stored in `IndexedDB`
- import state and lightweight settings live in `chrome.storage.local`
- embeddings are stored locally and quantized to reduce archive size

### 3. Retrieval Layer

- lexical scoring for exact text, author, keyword, and metadata matches
- semantic retrieval using local embeddings
- hybrid ranking with coverage-aware weighting
- topic inference layered on top of retrieval

### 4. UI Layer

- side panel as the main product surface
- search, filters, sort controls, export, diagnostics, and answer mode

## Tech Stack

- Chrome Extension Manifest V3
- TypeScript
- React
- Vite
- Tailwind CSS v4
- IndexedDB
- `@huggingface/transformers`
- ONNX WebAssembly / WebGPU runtime

## AI Stack

Current AI model:

- `Xenova/all-MiniLM-L6-v2`

Current AI responsibilities:

- semantic embeddings
- hybrid retrieval
- topic inference
- citation-first answer layer

This project does not currently use a full local generation model as the primary answer engine. Retrieval comes first, then answer synthesis on top of retrieved evidence.

## Repository Layout

Key paths:

- [src/background.ts](/Users/emirhan/Desktop/xLikeSearch/src/background.ts)
- [src/content.ts](/Users/emirhan/Desktop/xLikeSearch/src/content.ts)
- [src/pageBridge.ts](/Users/emirhan/Desktop/xLikeSearch/src/pageBridge.ts)
- [src/lib/db.ts](/Users/emirhan/Desktop/xLikeSearch/src/lib/db.ts)
- [src/lib/semantic.ts](/Users/emirhan/Desktop/xLikeSearch/src/lib/semantic.ts)
- [src/lib/xApiParser.ts](/Users/emirhan/Desktop/xLikeSearch/src/lib/xApiParser.ts)
- [src/sidepanel/App.tsx](/Users/emirhan/Desktop/xLikeSearch/src/sidepanel/App.tsx)
- [public/manifest.json](/Users/emirhan/Desktop/xLikeSearch/public/manifest.json)

## Local Development

Install dependencies:

```bash
npm install
```

Build the extension:

```bash
npm run build
```

Type-check:

```bash
npm run check
```

Run tests:

```bash
npm run test
```

Load the built extension from:

- [dist](/Users/emirhan/Desktop/xLikeSearch/dist)

## How Import Works

Preferred path:

1. open a background likes tab
2. capture X timeline requests
3. page through the likes timeline using cursors
4. write results into the local archive

Fallback path:

1. scan visible tweet cards from the page
2. continue page import only if network capture is unavailable

## Search Modes

### Search

Used for:

- keywords
- authors
- topic filters
- hybrid semantic retrieval

### Ask My Likes

Used for:

- retrieval-first answering
- citation-backed summaries
- quick synthesis over top matching liked tweets

## Export

Supported today:

- current results as JSON
- current results as CSV
- full archive as JSON
- full archive as CSV

## Known Constraints

- X can change internal request and payload shapes
- category intelligence is improving but still imperfect
- semantic coverage depends on local embedding completion
- the current answer layer is retrieval-backed, not a full local LLM chat system

## Next Steps

Immediate product work:

- importer confidence and freshness states
- stronger semantic categorization
- better filtered RAG queries
- saved views and collections
- more precise answer formatting

More detailed build order lives in:

- [PRODUCTION_ROADMAP.md](/Users/emirhan/Desktop/xLikeSearch/PRODUCTION_ROADMAP.md)
