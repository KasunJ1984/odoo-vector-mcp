# Vector1984 - Incremental Improvement Plan

**Project:** odoo-vector-mcp
**Created:** December 2024
**Purpose:** Step-by-step implementation guide for advanced vector database optimizations

---

## Overview

This document tracks incremental improvements to the Odoo Vector MCP server. Each improvement builds on previous ones, with detailed plans, test scenarios, and to-do lists.

**Current System Baseline:**
- 17,930 schema fields indexed
- 709 Odoo models
- 1024-dimensional Voyage-3 embeddings (float32)
- Qdrant Cloud (AWS ap-southeast-2)
- Memory: ~73.5 MB vectors
- Sync time: ~40-75 seconds full sync

---

## Progress Tracker

| # | Improvement | Status | Date Completed | Notes |
|---|-------------|--------|----------------|-------|
| 0 | Bug Fixes (references_in, error logging) | ✅ DONE | Dec 2024 | Commits: 578e5e1, 7a840d4, f57c6c5 |
| 1 | Scalar Quantization | ✅ DONE | Dec 15, 2024 | Commit: 721341d - 75% memory reduction verified |
| 2 | Query Caching (LRU) | 🔲 TODO | - | Faster repeat queries |
| 3 | HNSW Parameter Tuning | 🔲 TODO | - | Better recall |
| 4 | Upgrade to Voyage-3.5 | 🔲 TODO | - | Better embeddings |
| 5 | Incremental Sync | 🔲 TODO | - | Faster updates |
| 6 | Reranking Layer | 🔲 TODO | - | Higher accuracy |
| 7 | Binary Quantization | 🔲 TODO | - | 32x compression |
| 8 | HyDE Implementation | 🔲 TODO | - | Better query understanding |
| 9 | Hybrid Search | 🔲 TODO | - | Keyword + semantic |
| 10 | Search Analytics | 🔲 TODO | - | Quality monitoring |

---

# Improvement #1: Scalar Quantization

## What Is Scalar Quantization?

**Simple Explanation:**
Think of your vectors like photographs. Currently, each pixel uses 32 bits of color (very precise). Scalar quantization reduces this to 8 bits per pixel - still looks good, but 4x smaller file size.

**Technical Details:**
- Current: float32 vectors (4 bytes per dimension)
- After: int8 vectors (1 byte per dimension)
- Memory reduction: 75% (73.5 MB → 18.4 MB)
- Search speed: Up to 2x faster
- Accuracy loss: Less than 1%

## Why Do This First?

1. **Highest impact, lowest effort** - Just configuration change
2. **No code changes** - Only collection settings
3. **Reversible** - Can recreate collection without quantization
4. **Foundation** - Prepares for binary quantization later

## Technical Plan

### Step 1: Update Collection Creation Code

**File:** `src/services/vector-client.ts`

**Current code (around line 88):**
```typescript
await qdrantClient.createCollection(QDRANT_CONFIG.COLLECTION, {
  vectors: {
    size: QDRANT_CONFIG.VECTOR_SIZE,
    distance: QDRANT_CONFIG.DISTANCE_METRIC,
  },
});
```

**New code:**
```typescript
await qdrantClient.createCollection(QDRANT_CONFIG.COLLECTION, {
  vectors: {
    size: QDRANT_CONFIG.VECTOR_SIZE,
    distance: QDRANT_CONFIG.DISTANCE_METRIC,
  },
  quantization_config: {
    scalar: {
      type: 'int8',
      quantile: 0.99,      // Exclude top 1% outliers for better accuracy
      always_ram: true,    // Keep quantized vectors in RAM for speed
    },
  },
});
```

### Step 2: Add Configuration Option

**File:** `src/constants.ts`

Add new configuration:
```typescript
export const QDRANT_CONFIG = {
  HOST: process.env.QDRANT_HOST || 'http://localhost:6333',
  API_KEY: process.env.QDRANT_API_KEY || '',
  COLLECTION: process.env.SCHEMA_COLLECTION_NAME || 'odoo_schema',
  VECTOR_SIZE: parseInt(process.env.VECTOR_SIZE || '1024', 10),
  DISTANCE_METRIC: 'Cosine' as const,
  // NEW: Quantization settings
  ENABLE_QUANTIZATION: process.env.ENABLE_QUANTIZATION !== 'false',
  QUANTIZATION_TYPE: (process.env.QUANTIZATION_TYPE || 'scalar') as 'scalar' | 'binary' | 'none',
} as const;
```

### Step 3: Update Search Parameters

**File:** `src/services/vector-client.ts`

Update `searchSchemaCollection` to use quantization-aware search:
```typescript
const results = await qdrantClient.search(QDRANT_CONFIG.COLLECTION, {
  vector,
  limit,
  score_threshold: minScore,
  filter: qdrantFilter,
  with_payload: true,
  params: {
    quantization: {
      rescore: true,       // Rescore results using original vectors
      oversampling: 1.5,   // Fetch 1.5x results, rescore to get best
    },
  },
});
```

### Step 4: Delete and Recreate Collection

```bash
# Delete existing collection
curl -k -X DELETE "https://[qdrant-host]:6333/collections/odoo_schema" \
  -H "api-key: [your-key]"

# Rebuild and sync
npm run build
# Then trigger full sync via MCP tool
```

## Test Scenarios

### Test 1: Verify Collection Created with Quantization
```bash
# Check collection info
curl -k "https://[qdrant-host]:6333/collections/odoo_schema" \
  -H "api-key: [your-key]" | jq '.result.config.quantization_config'
```

**Expected output:**
```json
{
  "scalar": {
    "type": "int8",
    "quantile": 0.99,
    "always_ram": true
  }
}
```

### Test 2: Semantic Search Quality
Run these queries before and after, compare results:

| Query | Expected Top Result | Before Score | After Score |
|-------|---------------------|--------------|-------------|
| "customer email address" | res.partner.email | | |
| "opportunity revenue" | crm.lead.expected_revenue | | |
| "salesperson name" | res.users.name | | |
| "deal probability" | crm.lead.probability | | |
| "company phone number" | res.partner.phone | | |

**Acceptance criteria:** Score difference < 0.05 (5%)

### Test 3: Memory Usage Comparison
```bash
# Before quantization
curl -k "https://[qdrant-host]:6333/collections/odoo_schema" \
  -H "api-key: [your-key]" | jq '.result.vectors_count, .result.points_count'
```

### Test 4: Search Latency
Run 10 searches, measure average time:
```typescript
const start = Date.now();
await searchSchemaCollection(vector, { limit: 10 });
const latency = Date.now() - start;
```

**Expected:** 20-50% latency reduction

### Test 5: All Search Modes
- [ ] Semantic search works
- [ ] List mode works
- [ ] References_in works
- [ ] References_out works

## To-Do List

- [ ] Read current `vector-client.ts` createSchemaCollection function
- [ ] Add quantization_config to collection creation
- [ ] Add ENABLE_QUANTIZATION to constants.ts
- [ ] Update searchSchemaCollection with rescore params
- [ ] Build project (`npm run build`)
- [ ] Delete existing Qdrant collection
- [ ] Run full sync to recreate with quantization
- [ ] Run Test 1: Verify quantization config
- [ ] Run Test 2: Compare search quality (5 queries)
- [ ] Run Test 3: Check memory usage
- [ ] Run Test 4: Measure latency
- [ ] Run Test 5: All search modes
- [ ] Commit changes to git
- [ ] Update this document with results

## Rollback Plan

If quantization causes problems:
1. Set `ENABLE_QUANTIZATION=false` in .env
2. Delete collection
3. Rebuild without quantization config
4. Full sync

---

# Improvement #2: Query Caching (LRU)

## What Is Query Caching?

**Simple Explanation:**
When someone asks the same question twice, why calculate the answer again? Caching stores recent answers so repeat questions are instant.

**Technical Details:**
- LRU (Least Recently Used) cache
- Stores query → results mapping
- Configurable size (default: 500 entries)
- TTL (Time To Live): 30 minutes
- Cache key: query + filters hash

## Why Do This Second?

1. **Immediate performance boost** - Repeat queries are instant
2. **No database changes** - Pure code addition
3. **Easy to measure** - Clear before/after metrics
4. **Builds on #1** - Quantized searches + caching = very fast

## Technical Plan

### Step 1: Install LRU Cache Package

```bash
cd C:\Users\KasunJ\MCP\odoo-vector-mcp
npm install lru-cache
npm install -D @types/lru-cache
```

### Step 2: Create Cache Service

**New file:** `src/services/cache-service.ts`

```typescript
/**
 * Cache Service
 *
 * LRU cache for vector search results.
 * Dramatically speeds up repeat queries.
 */

import { LRUCache } from 'lru-cache';
import type { VectorSearchResult } from '../types.js';

// Cache configuration
const CACHE_CONFIG = {
  MAX_ENTRIES: parseInt(process.env.CACHE_MAX_ENTRIES || '500', 10),
  TTL_MS: parseInt(process.env.CACHE_TTL_MS || '1800000', 10), // 30 minutes
};

// The cache instance
const searchCache = new LRUCache<string, VectorSearchResult[]>({
  max: CACHE_CONFIG.MAX_ENTRIES,
  ttl: CACHE_CONFIG.TTL_MS,
});

// Statistics
let cacheHits = 0;
let cacheMisses = 0;

/**
 * Generate cache key from search parameters
 */
export function generateCacheKey(
  query: string,
  mode: string,
  filters: Record<string, unknown>
): string {
  const filterStr = JSON.stringify(filters, Object.keys(filters).sort());
  return `${mode}:${query}:${filterStr}`;
}

/**
 * Get cached results
 */
export function getCachedResults(key: string): VectorSearchResult[] | undefined {
  const result = searchCache.get(key);
  if (result) {
    cacheHits++;
    console.error(`[Cache] HIT: ${key.substring(0, 50)}...`);
  } else {
    cacheMisses++;
    console.error(`[Cache] MISS: ${key.substring(0, 50)}...`);
  }
  return result;
}

/**
 * Store results in cache
 */
export function setCachedResults(key: string, results: VectorSearchResult[]): void {
  searchCache.set(key, results);
  console.error(`[Cache] STORED: ${results.length} results`);
}

/**
 * Clear entire cache (call after sync)
 */
export function clearCache(): void {
  searchCache.clear();
  console.error('[Cache] CLEARED');
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: string;
} {
  const total = cacheHits + cacheMisses;
  return {
    size: searchCache.size,
    maxSize: CACHE_CONFIG.MAX_ENTRIES,
    hits: cacheHits,
    misses: cacheMisses,
    hitRate: total > 0 ? `${((cacheHits / total) * 100).toFixed(1)}%` : '0%',
  };
}
```

### Step 3: Integrate Cache into Search Tool

**File:** `src/tools/search-tool.ts`

Add caching wrapper to the main search function:
```typescript
import {
  generateCacheKey,
  getCachedResults,
  setCachedResults
} from '../services/cache-service.js';

// Inside the search handler, before calling actual search:
const cacheKey = generateCacheKey(query, mode, { model_name, field_types, limit });
const cached = getCachedResults(cacheKey);
if (cached) {
  return formatResults(cached, mode, query);
}

// After getting results:
setCachedResults(cacheKey, results);
```

### Step 4: Clear Cache After Sync

**File:** `src/services/sync-service.ts`

```typescript
import { clearCache } from './cache-service.js';

// At the end of sync operation:
clearCache();
console.error('[Sync] Cache cleared after sync');
```

### Step 5: Add Cache Stats to Health Check

**File:** `src/tools/vector-tools.ts` (or wherever status is returned)

```typescript
import { getCacheStats } from '../services/cache-service.js';

// In status response:
const cacheStats = getCacheStats();
// Include in output
```

## Test Scenarios

### Test 1: Cache Hit on Repeat Query
```
Query 1: "customer email" → Cache MISS → ~200ms
Query 2: "customer email" → Cache HIT → <5ms
```

### Test 2: Different Queries Don't Collide
```
Query 1: "customer email" → Results for email
Query 2: "customer phone" → Different results (not cached email)
```

### Test 3: Filter Changes Invalidate Cache
```
Query 1: "email" (no filter) → Result A
Query 2: "email" (model=res.partner) → Result B (different cache key)
```

### Test 4: Cache Clears After Sync
```
Query 1: "customer email" → Cached
Sync: full_sync
Query 2: "customer email" → Cache MISS (cleared)
```

### Test 5: Stats Accuracy
```
Run 10 queries (5 unique, 5 repeats)
Expected: 5 hits, 5 misses, 50% hit rate
```

## To-Do List

- [ ] Install lru-cache package
- [ ] Create cache-service.ts
- [ ] Integrate cache into search-tool.ts
- [ ] Add cache clear to sync-service.ts
- [ ] Add cache stats to status output
- [ ] Build project
- [ ] Run Test 1: Repeat query speed
- [ ] Run Test 2: Different queries
- [ ] Run Test 3: Filter changes
- [ ] Run Test 4: Sync clears cache
- [ ] Run Test 5: Stats accuracy
- [ ] Commit changes
- [ ] Update this document

## Configuration Options

Add to `.env`:
```bash
# Cache settings (optional)
CACHE_MAX_ENTRIES=500
CACHE_TTL_MS=1800000  # 30 minutes
```

---

# Improvement #3: HNSW Parameter Tuning

## What Is HNSW?

**Simple Explanation:**
HNSW (Hierarchical Navigable Small World) is like a smart filing system. Instead of checking every document, it creates shortcuts to find similar items quickly. Better tuning = finding the right documents more often.

**Technical Details:**
- `m`: Number of connections per node (more = better recall, more memory)
- `ef_construct`: Build quality (higher = better index, slower build)
- `ef` (search): Search effort (higher = better recall, slower search)

## Current vs Optimized Settings

| Parameter | Default | Optimized | Impact |
|-----------|---------|-----------|--------|
| `m` | 16 | 32 | +15% recall |
| `ef_construct` | 100 | 200 | Better index |
| `full_scan_threshold` | 10000 | 5000 | Exact search for small filters |

## Why Do This Third?

1. **After quantization** - Full vectors needed for HNSW build
2. **Complements caching** - Non-cached queries are more accurate
3. **One-time cost** - Only affects collection creation

## Technical Plan

### Step 1: Add HNSW Config to Constants

**File:** `src/constants.ts`

```typescript
export const QDRANT_CONFIG = {
  // ... existing config ...

  // HNSW tuning
  HNSW_M: parseInt(process.env.HNSW_M || '32', 10),
  HNSW_EF_CONSTRUCT: parseInt(process.env.HNSW_EF_CONSTRUCT || '200', 10),
  HNSW_FULL_SCAN_THRESHOLD: parseInt(process.env.HNSW_FULL_SCAN_THRESHOLD || '5000', 10),
} as const;
```

### Step 2: Update Collection Creation

**File:** `src/services/vector-client.ts`

```typescript
await qdrantClient.createCollection(QDRANT_CONFIG.COLLECTION, {
  vectors: {
    size: QDRANT_CONFIG.VECTOR_SIZE,
    distance: QDRANT_CONFIG.DISTANCE_METRIC,
  },
  quantization_config: {
    scalar: {
      type: 'int8',
      quantile: 0.99,
      always_ram: true,
    },
  },
  hnsw_config: {
    m: QDRANT_CONFIG.HNSW_M,
    ef_construct: QDRANT_CONFIG.HNSW_EF_CONSTRUCT,
    full_scan_threshold: QDRANT_CONFIG.HNSW_FULL_SCAN_THRESHOLD,
  },
});
```

### Step 3: Add Search-Time ef Parameter

```typescript
const results = await qdrantClient.search(QDRANT_CONFIG.COLLECTION, {
  vector,
  limit,
  score_threshold: minScore,
  filter: qdrantFilter,
  with_payload: true,
  params: {
    hnsw_ef: 128,  // Higher ef for better recall at search time
    quantization: {
      rescore: true,
      oversampling: 1.5,
    },
  },
});
```

## Test Scenarios

### Test 1: Recall Comparison
Search for known fields, verify they appear in results:

| Query | Target Field | Before Rank | After Rank |
|-------|--------------|-------------|------------|
| "partner email" | res.partner.email | | |
| "lead revenue" | crm.lead.expected_revenue | | |
| "user login" | res.users.login | | |

### Test 2: Edge Case Queries
Test queries that previously returned poor results:

| Query | Should Find | Works? |
|-------|-------------|--------|
| "customer contact info" | Multiple partner fields | |
| "sales pipeline stage" | crm.stage fields | |
| "order amount total" | sale.order amount fields | |

### Test 3: Build Time
Measure full sync time (acceptable if <2x slower build):
- Before HNSW tuning: _____ seconds
- After HNSW tuning: _____ seconds

## To-Do List

- [ ] Add HNSW config to constants.ts
- [ ] Update createSchemaCollection with hnsw_config
- [ ] Add hnsw_ef to search params
- [ ] Build project
- [ ] Delete and recreate collection
- [ ] Run full sync
- [ ] Run Test 1: Recall comparison
- [ ] Run Test 2: Edge cases
- [ ] Run Test 3: Build time
- [ ] Commit changes
- [ ] Update this document

---

# Improvement #4: Upgrade to Voyage-3.5

## What Is Voyage-3.5?

**Simple Explanation:**
Voyage-3.5 is the newer, smarter version of the embedding model. Like upgrading from a good translator to a great one - understands meaning better.

**Key Benefits:**
1. Better retrieval quality
2. Supports Matryoshka (flexible dimensions)
3. Better quantization support
4. Same pricing as Voyage-3

## Why Do This Fourth?

1. **After infrastructure ready** - Quantization and HNSW optimized
2. **Full re-embed required** - All vectors change
3. **Major improvement** - Affects all searches

## Technical Plan

### Step 1: Update Embedding Configuration

**File:** `src/constants.ts`

```typescript
export const VOYAGE_CONFIG = {
  API_KEY: process.env.VOYAGE_API_KEY || '',
  MODEL: process.env.EMBEDDING_MODEL || 'voyage-3.5-lite',  // Changed from voyage-3
  DIMENSIONS: parseInt(process.env.VECTOR_SIZE || '1024', 10),
  MAX_BATCH_SIZE: 128,
  INPUT_TYPE_DOCUMENT: 'document' as const,
  INPUT_TYPE_QUERY: 'query' as const,
} as const;
```

### Step 2: Test API Compatibility

Voyage-3.5 uses same API, but verify:
```typescript
const response = await voyage.embed({
  input: ['test embedding'],
  model: 'voyage-3.5-lite',
  inputType: 'document',
});
console.log('Dimensions:', response.data[0].embedding.length);
```

### Step 3: Update .env

```bash
EMBEDDING_MODEL=voyage-3.5-lite
# Or for higher quality:
# EMBEDDING_MODEL=voyage-3.5
```

### Step 4: Re-embed All Data

1. Delete collection
2. Full sync (all 17,930 fields get new embeddings)
3. Verify counts match

## Test Scenarios

### Test 1: API Works
```bash
# Simple embedding test
curl https://api.voyageai.com/v1/embeddings \
  -H "Authorization: Bearer $VOYAGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": ["test"], "model": "voyage-3.5-lite"}'
```

### Test 2: Quality Comparison
Run same queries, compare relevance:

| Query | Voyage-3 Top Result | Voyage-3.5 Top Result | Better? |
|-------|---------------------|----------------------|---------|
| "customer email" | | | |
| "opportunity amount" | | | |
| "sales team" | | | |

### Test 3: Full Sync Completes
- All 17,930 fields embedded
- No API errors
- Collection has correct count

## To-Do List

- [ ] Update VOYAGE_CONFIG model name
- [ ] Update .env with new model
- [ ] Test API call works
- [ ] Delete existing collection
- [ ] Run full sync
- [ ] Verify vector count (17,930)
- [ ] Run quality comparison tests
- [ ] Commit changes
- [ ] Update this document

---

# Improvement #5: Incremental Sync

## What Is Incremental Sync?

**Simple Explanation:**
Currently, every sync re-embeds all 17,930 fields (40-75 seconds). Incremental sync only processes what changed - maybe 10-50 fields after a schema update.

**Technical Details:**
- Track field checksums (hash of field content)
- Compare with previous sync
- Only embed added/modified fields
- Delete removed fields

## Why Do This Fifth?

1. **After embeddings stable** - Voyage-3.5 is final model
2. **Reduces API costs** - Fewer embedding calls
3. **Faster updates** - Seconds instead of minutes
4. **Foundation for live sync** - Could watch Odoo changes

## Technical Plan

### Step 1: Create Sync Metadata Storage

**New file:** `src/services/sync-metadata.ts`

```typescript
/**
 * Sync Metadata Service
 *
 * Tracks field checksums for incremental sync.
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const METADATA_FILE = 'data/sync-metadata.json';

interface SyncMetadata {
  lastSync: string;
  totalFields: number;
  fieldChecksums: Record<number, string>;  // field_id → hash
}

/**
 * Generate checksum for a schema field
 */
export function generateFieldChecksum(field: {
  field_name: string;
  field_label: string;
  field_type: string;
  model_name: string;
  primary_data_location: string;
  stored: boolean;
}): string {
  const content = JSON.stringify(field);
  return createHash('md5').update(content).digest('hex');
}

/**
 * Load previous sync metadata
 */
export function loadSyncMetadata(): SyncMetadata | null {
  if (!existsSync(METADATA_FILE)) return null;
  try {
    const content = readFileSync(METADATA_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Save sync metadata
 */
export function saveSyncMetadata(metadata: SyncMetadata): void {
  writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
}

/**
 * Detect changes between syncs
 */
export function detectChanges(
  previous: SyncMetadata | null,
  current: Map<number, string>  // field_id → checksum
): {
  added: number[];
  modified: number[];
  deleted: number[];
} {
  if (!previous) {
    return {
      added: Array.from(current.keys()),
      modified: [],
      deleted: []
    };
  }

  const added: number[] = [];
  const modified: number[] = [];
  const deleted: number[] = [];

  // Check current fields
  for (const [fieldId, checksum] of current) {
    if (!(fieldId in previous.fieldChecksums)) {
      added.push(fieldId);
    } else if (previous.fieldChecksums[fieldId] !== checksum) {
      modified.push(fieldId);
    }
  }

  // Check for deleted fields
  for (const fieldId of Object.keys(previous.fieldChecksums)) {
    if (!current.has(Number(fieldId))) {
      deleted.push(Number(fieldId));
    }
  }

  return { added, modified, deleted };
}
```

### Step 2: Update Sync Service

**File:** `src/services/sync-service.ts`

Add incremental sync option:
```typescript
export async function incrementalSync(): Promise<{
  added: number;
  modified: number;
  deleted: number;
  skipped: number;
}> {
  const previousMeta = loadSyncMetadata();
  const currentSchema = loadSchema();  // Your existing function

  // Build checksum map
  const currentChecksums = new Map<number, string>();
  for (const field of currentSchema) {
    currentChecksums.set(field.field_id, generateFieldChecksum(field));
  }

  const changes = detectChanges(previousMeta, currentChecksums);

  console.error(`[Sync] Changes detected: ${changes.added.length} added, ${changes.modified.length} modified, ${changes.deleted.length} deleted`);

  // Process only changed fields
  if (changes.added.length + changes.modified.length > 0) {
    const fieldsToEmbed = currentSchema.filter(
      f => changes.added.includes(f.field_id) || changes.modified.includes(f.field_id)
    );
    await embedAndUpsert(fieldsToEmbed);
  }

  if (changes.deleted.length > 0) {
    await deleteSchemaPoints(changes.deleted);
  }

  // Save new metadata
  saveSyncMetadata({
    lastSync: new Date().toISOString(),
    totalFields: currentSchema.length,
    fieldChecksums: Object.fromEntries(currentChecksums),
  });

  return {
    added: changes.added.length,
    modified: changes.modified.length,
    deleted: changes.deleted.length,
    skipped: currentSchema.length - changes.added.length - changes.modified.length,
  };
}
```

### Step 3: Add Delete Function to Vector Client

**File:** `src/services/vector-client.ts`

```typescript
export async function deleteSchemaPoints(fieldIds: number[]): Promise<void> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  await qdrantClient.delete(QDRANT_CONFIG.COLLECTION, {
    points: fieldIds,
  });

  console.error(`[Vector] Deleted ${fieldIds.length} points`);
}
```

## Test Scenarios

### Test 1: First Incremental = Full
```
No metadata file exists
Run incremental sync
Expected: All 17,930 fields as "added"
```

### Test 2: No Changes = No Embedding
```
Run incremental sync immediately after
Expected: 0 added, 0 modified, 0 deleted, 17930 skipped
Time: <1 second
```

### Test 3: Simulated Change
```
Manually modify one field in schema file
Run incremental sync
Expected: 0 added, 1 modified, 0 deleted, 17929 skipped
```

### Test 4: Deleted Field
```
Remove one field from schema file
Run incremental sync
Expected: 0 added, 0 modified, 1 deleted
Vector count: 17,929
```

## To-Do List

- [ ] Create sync-metadata.ts
- [ ] Add generateFieldChecksum function
- [ ] Add detectChanges function
- [ ] Update sync-service.ts with incrementalSync
- [ ] Add deleteSchemaPoints to vector-client.ts
- [ ] Add sync mode option to MCP tool (full/incremental)
- [ ] Build project
- [ ] Test 1: First incremental
- [ ] Test 2: No changes
- [ ] Test 3: Simulated change
- [ ] Test 4: Deleted field
- [ ] Commit changes
- [ ] Update this document

---

# Improvement #6: Reranking Layer

## What Is Reranking?

**Simple Explanation:**
Vector search is fast but not always most accurate. Reranking takes the top results and uses a smarter (but slower) model to re-order them. Like speed-reading 50 documents, then carefully reading the top 5.

**Technical Details:**
- Stage 1: Vector search returns 50 candidates (fast)
- Stage 2: Cross-encoder scores each candidate against query (accurate)
- Stage 3: Return top 10 reranked results

## Why Do This Sixth?

1. **After embeddings optimized** - Base quality is good
2. **Adds API cost** - Extra Voyage API call
3. **High impact** - Significantly better top results

## Technical Plan

### Step 1: Install Voyage Reranker

Already included in `voyageai` package.

### Step 2: Create Reranker Service

**New file:** `src/services/reranker-service.ts`

```typescript
/**
 * Reranker Service
 *
 * Uses Voyage AI rerank model for improved result ordering.
 */

import Anthropic from 'voyageai';  // or however your client is set up
import type { VectorSearchResult } from '../types.js';

const RERANK_CONFIG = {
  MODEL: process.env.RERANK_MODEL || 'rerank-2',
  TOP_K: parseInt(process.env.RERANK_TOP_K || '10', 10),
  ENABLED: process.env.ENABLE_RERANKING !== 'false',
};

interface RerankResult {
  index: number;
  relevance_score: number;
}

/**
 * Rerank search results using cross-encoder
 */
export async function rerankResults(
  query: string,
  candidates: VectorSearchResult[],
  voyageClient: any  // Your Voyage client type
): Promise<VectorSearchResult[]> {
  if (!RERANK_CONFIG.ENABLED || candidates.length === 0) {
    return candidates;
  }

  // Extract semantic text for reranking
  const documents = candidates.map(c => c.payload.semantic_text);

  try {
    const response = await voyageClient.rerank({
      query: query,
      documents: documents,
      model: RERANK_CONFIG.MODEL,
      top_k: Math.min(RERANK_CONFIG.TOP_K, candidates.length),
    });

    // Map reranked results back to original candidates
    return response.results.map((r: RerankResult) => ({
      ...candidates[r.index],
      score: r.relevance_score,  // Replace vector score with rerank score
      originalVectorScore: candidates[r.index].score,
    }));
  } catch (error) {
    console.error('[Rerank] Failed, returning original order:', error);
    return candidates.slice(0, RERANK_CONFIG.TOP_K);
  }
}
```

### Step 3: Integrate into Search Flow

**File:** `src/tools/search-tool.ts`

```typescript
// After vector search, before returning:
if (mode === 'semantic') {
  // Fetch more candidates for reranking
  const candidates = await searchSchemaCollection(vector, {
    limit: limit * 3,  // Get 3x for reranking
    minScore: minScore * 0.7,  // Lower threshold for candidates
  });

  // Rerank to get best results
  const reranked = await rerankResults(query, candidates, voyageClient);
  return reranked.slice(0, limit);
}
```

## Test Scenarios

### Test 1: Reranking Improves Order
```
Query: "customer contact information"
Without rerank: email, phone, name, address...
With rerank: name, email, phone, mobile... (more relevant order)
```

### Test 2: Rerank Disabled Falls Back
```
Set ENABLE_RERANKING=false
Search should work normally (just slower)
```

### Test 3: API Error Handling
```
Simulate API failure (invalid key)
Should return original results, not crash
```

## To-Do List

- [ ] Create reranker-service.ts
- [ ] Add RERANK config to constants
- [ ] Integrate rerankResults into search
- [ ] Add ENABLE_RERANKING to .env
- [ ] Build project
- [ ] Test with/without reranking
- [ ] Measure quality improvement
- [ ] Commit changes
- [ ] Update this document

---

# Improvement #7: Binary Quantization

## What Is Binary Quantization?

**Simple Explanation:**
Even more aggressive compression than scalar. Each dimension becomes 1 bit (on/off) instead of 8 bits. 32x smaller, 40x faster initial search. Requires oversampling for accuracy.

**Technical Details:**
- Current (with scalar): int8 (1 byte per dimension)
- With binary: 1 bit per dimension
- Memory: 18.4 MB → ~0.6 MB
- Search: 40x faster initial pass
- Requires: 1024+ dimensions (we have 1024) ✓

## Why Do This Seventh?

1. **After reranking ready** - Reranking compensates for accuracy loss
2. **Requires oversampling** - Need good base system first
3. **Maximum compression** - Final optimization step

## Technical Plan

### Step 1: Update Collection Configuration

```typescript
await qdrantClient.createCollection(QDRANT_CONFIG.COLLECTION, {
  vectors: {
    size: QDRANT_CONFIG.VECTOR_SIZE,
    distance: QDRANT_CONFIG.DISTANCE_METRIC,
    on_disk: true,  // Store full vectors on disk
  },
  quantization_config: {
    binary: {
      always_ram: true,  // Binary vectors in RAM for speed
    },
  },
  hnsw_config: {
    m: QDRANT_CONFIG.HNSW_M,
    ef_construct: QDRANT_CONFIG.HNSW_EF_CONSTRUCT,
  },
});
```

### Step 2: Update Search with Oversampling

```typescript
const results = await qdrantClient.search(QDRANT_CONFIG.COLLECTION, {
  vector,
  limit,
  score_threshold: minScore,
  filter: qdrantFilter,
  with_payload: true,
  params: {
    hnsw_ef: 128,
    quantization: {
      rescore: true,       // CRITICAL: Rescore with full vectors
      oversampling: 3.0,   // Fetch 3x, rescore to get best
    },
  },
});
```

## Test Scenarios

### Test 1: Memory Reduction
```
Before: ~18 MB (scalar)
After: ~0.6 MB (binary)
```

### Test 2: Search Speed
```
Measure 100 searches
Expected: <10ms average (vs 20-50ms scalar)
```

### Test 3: Accuracy with Reranking
```
Binary search + reranking should match scalar quality
Compare top 10 results
```

## To-Do List

- [ ] Update collection config for binary quantization
- [ ] Update search params with oversampling=3.0
- [ ] Build project
- [ ] Delete and recreate collection
- [ ] Full sync
- [ ] Test memory usage
- [ ] Test search speed
- [ ] Test accuracy with reranking
- [ ] Commit changes
- [ ] Update this document

---

# Improvement #8: HyDE Implementation

## What Is HyDE?

**Simple Explanation:**
HyDE (Hypothetical Document Embeddings) means: instead of embedding "customer email", first ask an LLM "What would a field for customer email look like?", then search for that detailed description. Bridges the gap between short queries and detailed schema docs.

**Example:**
```
User query: "customer email"

Normal: Embed "customer email" → Search

HyDE:
1. Ask LLM: "Describe an Odoo field for customer email"
2. LLM: "A field called email in res.partner model, type char,
   stores primary contact email address for customer communication..."
3. Embed that description
4. Search → More accurate results
```

## Why Do This Eighth?

1. **After base search excellent** - Only needed for difficult queries
2. **Adds latency** - Extra LLM call
3. **Advanced feature** - For complex queries

## Technical Plan

### Step 1: Create HyDE Service

**New file:** `src/services/hyde-service.ts`

```typescript
/**
 * HyDE (Hypothetical Document Embeddings) Service
 *
 * Generates hypothetical schema descriptions to improve query understanding.
 */

const HYDE_PROMPT = `You are an Odoo ERP schema expert. Given a user's search query,
generate a hypothetical schema field description that would answer their question.

Include:
- Model name (e.g., res.partner, crm.lead, sale.order)
- Field name (technical name like partner_id, expected_revenue)
- Field type (char, many2one, float, boolean, etc.)
- Display label
- Purpose and typical values

User query: "{query}"

Hypothetical field description:`;

/**
 * Generate hypothetical document for query
 */
export async function generateHypotheticalDoc(
  query: string,
  llmClient: any  // Claude or other LLM client
): Promise<string> {
  const prompt = HYDE_PROMPT.replace('{query}', query);

  const response = await llmClient.messages.create({
    model: 'claude-3-haiku-20240307',  // Fast, cheap model
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

/**
 * HyDE-enhanced search
 */
export async function hydeSearch(
  query: string,
  llmClient: any,
  embedClient: any,
  searchFn: Function
): Promise<any[]> {
  // Generate hypothetical document
  const hypotheticalDoc = await generateHypotheticalDoc(query, llmClient);

  // Embed as document (not query)
  const embedding = await embedClient.embed({
    input: [hypotheticalDoc],
    model: 'voyage-3.5-lite',
    inputType: 'document',
  });

  // Search with hypothetical embedding
  return searchFn(embedding.data[0].embedding);
}
```

### Step 2: Add HyDE Mode Option

Allow users to enable HyDE for specific searches:
```typescript
// In search tool schema:
hyde: z.boolean().default(false).describe('Use HyDE for improved query understanding'),
```

## Test Scenarios

### Test 1: Vague Query Improvement
```
Query: "contact info" (vague)
Without HyDE: Mixed results
With HyDE: Better focus on actual contact fields
```

### Test 2: Domain-Specific Terms
```
Query: "pipeline stage" (Odoo-specific)
HyDE should expand to crm.stage understanding
```

## To-Do List

- [ ] Create hyde-service.ts
- [ ] Add Claude/LLM client integration
- [ ] Add hyde option to search schema
- [ ] Build project
- [ ] Test vague queries
- [ ] Test domain-specific queries
- [ ] Measure latency impact
- [ ] Commit changes
- [ ] Update this document

---

# Improvement #9: Hybrid Search (BM25 + Vector)

## What Is Hybrid Search?

**Simple Explanation:**
Combines keyword search (exact matches) with vector search (meaning). Best of both worlds.

**Example:**
```
Query: "partner_id in crm.lead"

Vector search: Finds semantically similar fields
BM25 search: Finds exact "partner_id" and "crm.lead" matches
Hybrid: Combines both for best results
```

## Technical Plan

### Option A: Qdrant Sparse Vectors (Recommended)
Qdrant 1.10+ supports sparse vectors for BM25-like search.

### Option B: Pre-filter + Merge
1. Exact keyword search via payload filters
2. Vector search separately
3. Merge results using Reciprocal Rank Fusion (RRF)

## To-Do List

- [ ] Research Qdrant sparse vector support
- [ ] Implement BM25 alternative or sparse vectors
- [ ] Create RRF merge function
- [ ] Test hybrid vs vector-only
- [ ] Commit changes
- [ ] Update this document

---

# Improvement #10: Search Analytics Dashboard

## What Is This?

Track search quality metrics to identify problems and improvements.

## Metrics to Track

- Query volume by type (semantic, list, references)
- Average result scores
- Cache hit rates
- Latency percentiles (p50, p95, p99)
- Zero-result queries
- User feedback (if available)

## To-Do List

- [ ] Create analytics-service.ts
- [ ] Add logging to all search paths
- [ ] Create summary report function
- [ ] Add to status tool output
- [ ] Commit changes
- [ ] Update this document

---

# Appendix: Environment Variables Reference

```bash
# Existing
ODOO_URL=https://your-odoo.com
ODOO_DB=your_database
ODOO_USERNAME=your_username
ODOO_PASSWORD=your_api_key
QDRANT_HOST=http://localhost:6333
QDRANT_API_KEY=
VOYAGE_API_KEY=your_api_key
VECTOR_SIZE=1024
EMBEDDING_MODEL=voyage-3.5-lite
SCHEMA_COLLECTION_NAME=odoo_schema
SCHEMA_DATA_FILE=data/odoo_schema.txt

# New (from improvements)
ENABLE_QUANTIZATION=true
QUANTIZATION_TYPE=scalar  # or binary
HNSW_M=32
HNSW_EF_CONSTRUCT=200
HNSW_FULL_SCAN_THRESHOLD=5000
CACHE_MAX_ENTRIES=500
CACHE_TTL_MS=1800000
ENABLE_RERANKING=true
RERANK_MODEL=rerank-2
RERANK_TOP_K=10
ENABLE_HYDE=false
```

---

# Change Log

| Date | Improvement | Status | Notes |
|------|-------------|--------|-------|
| Dec 2024 | Bug fixes (references_in, logging) | ✅ Done | Commits: 578e5e1, 7a840d4, f57c6c5 |
| Dec 15, 2024 | #1 Scalar Quantization | ✅ Done | Commit: 721341d - int8 quantization, rescore params |
| | #2 Query Caching | 🔲 Pending | |
| | #3 HNSW Tuning | 🔲 Pending | |
| | #4 Voyage-3.5 | 🔲 Pending | |
| | #5 Incremental Sync | 🔲 Pending | |
| | #6 Reranking | 🔲 Pending | |
| | #7 Binary Quantization | 🔲 Pending | |
| | #8 HyDE | 🔲 Pending | |
| | #9 Hybrid Search | 🔲 Pending | |
| | #10 Analytics | 🔲 Pending | |

---

*Document created: December 2024*
*Last updated: December 2024*
