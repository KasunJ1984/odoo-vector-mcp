/**
 * Vector Client
 *
 * Manages the Qdrant odoo_schema collection for semantic schema search.
 * Simplified for Phase 1 - schema search only.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { QDRANT_CONFIG, SIMILARITY_THRESHOLDS } from '../constants.js';
import type { SchemaPoint, SchemaPayload, SchemaFilter, VectorSearchResult } from '../types.js';

// =============================================================================
// CLIENT INITIALIZATION
// =============================================================================

let qdrantClient: QdrantClient | null = null;

/**
 * Initialize the Qdrant client
 */
export function initializeVectorClient(): boolean {
  try {
    const config: { url: string; apiKey?: string; checkCompatibility?: boolean } = {
      url: QDRANT_CONFIG.HOST,
      checkCompatibility: false, // Skip version check for cloud compatibility
    };

    if (QDRANT_CONFIG.API_KEY) {
      config.apiKey = QDRANT_CONFIG.API_KEY;
    }

    qdrantClient = new QdrantClient(config);
    console.error('[Vector] Qdrant client initialized:', QDRANT_CONFIG.HOST);
    return true;
  } catch (error) {
    console.error('[Vector] Failed to initialize Qdrant client:', error);
    return false;
  }
}

/**
 * Check if vector client is available
 */
export function isVectorClientAvailable(): boolean {
  return qdrantClient !== null;
}

/**
 * Get the raw Qdrant client (for advanced operations)
 */
export function getQdrantClient(): QdrantClient {
  if (!qdrantClient) {
    throw new Error('Vector client not initialized');
  }
  return qdrantClient;
}

// =============================================================================
// COLLECTION MANAGEMENT
// =============================================================================

/**
 * Check if a collection exists
 */
export async function collectionExists(collectionName: string): Promise<boolean> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  try {
    const collections = await qdrantClient.getCollections();
    return collections.collections.some(c => c.name === collectionName);
  } catch {
    return false;
  }
}

/**
 * Create the schema collection
 */
export async function createSchemaCollection(): Promise<boolean> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const exists = await collectionExists(QDRANT_CONFIG.COLLECTION);
  if (exists) {
    console.error(`[Vector] Collection '${QDRANT_CONFIG.COLLECTION}' already exists`);
    return false;
  }

  await qdrantClient.createCollection(QDRANT_CONFIG.COLLECTION, {
    vectors: {
      size: QDRANT_CONFIG.VECTOR_SIZE,
      distance: QDRANT_CONFIG.DISTANCE_METRIC,
    },
  });

  // Create payload indexes for efficient filtering
  const indexFields = [
    { field: 'model_name', type: 'keyword' as const },
    { field: 'field_name', type: 'keyword' as const },
    { field: 'field_type', type: 'keyword' as const },
    { field: 'stored', type: 'bool' as const },
    { field: 'model_id', type: 'integer' as const },
    { field: 'field_id', type: 'integer' as const },
    { field: 'primary_data_location', type: 'keyword' as const },  // For references_in mode
  ];

  for (const { field, type } of indexFields) {
    try {
      await qdrantClient.createPayloadIndex(QDRANT_CONFIG.COLLECTION, {
        field_name: field,
        field_schema: type,
      });
    } catch {
      // Index might already exist
    }
  }

  console.error(`[Vector] Created collection '${QDRANT_CONFIG.COLLECTION}'`);
  return true;
}

/**
 * Delete a collection
 */
export async function deleteCollection(collectionName: string): Promise<boolean> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  try {
    await qdrantClient.deleteCollection(collectionName);
    console.error(`[Vector] Deleted collection '${collectionName}'`);
    return true;
  } catch {
    console.error(`[Vector] Collection '${collectionName}' does not exist`);
    return false;
  }
}

/**
 * Get collection info
 */
export async function getCollectionInfo(collectionName: string): Promise<{
  exists: boolean;
  vectorCount: number;
}> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  try {
    const info = await qdrantClient.getCollection(collectionName);
    return {
      exists: true,
      vectorCount: info.points_count ?? 0,
    };
  } catch {
    return { exists: false, vectorCount: 0 };
  }
}

// =============================================================================
// SCHEMA OPERATIONS
// =============================================================================

/**
 * Upsert schema points to collection
 */
export async function upsertSchemaPoints(points: SchemaPoint[]): Promise<void> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  await qdrantClient.upsert(QDRANT_CONFIG.COLLECTION, {
    wait: true,
    points: points.map(p => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload as unknown as Record<string, unknown>,
    })),
  });
}

/**
 * Search schema collection by vector with optional filters
 */
export async function searchSchemaCollection(
  vector: number[],
  options: {
    limit?: number;
    minScore?: number;
    filter?: SchemaFilter;
  } = {}
): Promise<VectorSearchResult[]> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const { limit = 10, minScore = SIMILARITY_THRESHOLDS.DEFAULT_MIN, filter } = options;

  const qdrantFilter = filter ? buildQdrantFilter(filter) : undefined;

  const results = await qdrantClient.search(QDRANT_CONFIG.COLLECTION, {
    vector,
    limit,
    score_threshold: minScore,
    filter: qdrantFilter,
    with_payload: true,
  });

  return results.map(r => ({
    id: r.id as number,
    score: r.score,
    payload: r.payload as unknown as SchemaPayload,
  }));
}

/**
 * Get a single schema by field_id
 */
export async function getSchemaPoint(fieldId: number): Promise<VectorSearchResult | null> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  try {
    const result = await qdrantClient.retrieve(QDRANT_CONFIG.COLLECTION, {
      ids: [fieldId],
      with_payload: true,
    });

    if (result.length === 0) return null;

    return {
      id: result[0].id as number,
      score: 1.0,
      payload: result[0].payload as unknown as SchemaPayload,
    };
  } catch {
    return null;
  }
}

/**
 * Count schemas matching filter
 */
export async function countSchemas(filter?: SchemaFilter): Promise<number> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const qdrantFilter = filter ? buildQdrantFilter(filter) : undefined;

  const result = await qdrantClient.count(QDRANT_CONFIG.COLLECTION, {
    filter: qdrantFilter,
    exact: true,
  });

  return result.count;
}

/**
 * Scroll schema collection with filters (no vector similarity)
 *
 * Used for list mode and reference searches where we want ALL matching
 * results, not just semantically similar ones.
 */
export async function scrollSchemaCollection(options: {
  filter: SchemaFilter;
  limit?: number;
}): Promise<VectorSearchResult[]> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const { filter, limit = 100 } = options;
  const qdrantFilter = buildQdrantFilter(filter);

  const results = await qdrantClient.scroll(QDRANT_CONFIG.COLLECTION, {
    filter: qdrantFilter,
    limit,
    with_payload: true,
    with_vector: false,
  });

  return results.points.map(p => ({
    id: p.id as number,
    score: 1.0, // No similarity score in scroll mode
    payload: p.payload as unknown as SchemaPayload,
  }));
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Build Qdrant filter from SchemaFilter
 *
 * Supports:
 * - Exact match on model_name
 * - Exact match or array of field_types
 * - Prefix match on primary_data_location (for references_in)
 * - Boolean match on stored
 */
function buildQdrantFilter(filter: SchemaFilter): { must: object[] } {
  const must: object[] = [];

  if (filter.model_name) {
    must.push({ key: 'model_name', match: { value: filter.model_name } });
  }

  // Support single field type or array of field types
  if (filter.field_type) {
    if (Array.isArray(filter.field_type)) {
      // Match any of the field types
      must.push({
        key: 'field_type',
        match: { any: filter.field_type },
      });
    } else {
      must.push({ key: 'field_type', match: { value: filter.field_type } });
    }
  }

  // Prefix match for primary_data_location (used in references_in mode)
  // e.g., "res.partner" matches "res.partner.id", "res.partner.name", etc.
  if (filter.primary_data_location_prefix) {
    must.push({
      key: 'primary_data_location',
      match: { text: filter.primary_data_location_prefix },
    });
  }

  if (filter.stored_only === true) {
    must.push({ key: 'stored', match: { value: true } });
  }

  return { must };
}
