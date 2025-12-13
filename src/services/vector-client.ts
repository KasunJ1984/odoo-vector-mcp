/**
 * Vector Client
 *
 * Manages two Qdrant collections:
 * - crm_schema: Schema definitions with semantic embeddings
 * - crm_data: Opportunity records with encoded strings
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { QDRANT_CONFIG, SIMILARITY_THRESHOLDS } from '../constants.js';
import type { VectorFilter, VectorSearchResult, OpportunityPayload, SchemaVector } from '../types.js';

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
      checkCompatibility: false,  // Skip version check for cloud compatibility
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
 * Create the schema collection (crm_schema)
 */
export async function createSchemaCollection(): Promise<boolean> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const exists = await collectionExists(QDRANT_CONFIG.SCHEMA_COLLECTION);
  if (exists) {
    console.error(`[Vector] Schema collection '${QDRANT_CONFIG.SCHEMA_COLLECTION}' already exists`);
    return false;
  }

  await qdrantClient.createCollection(QDRANT_CONFIG.SCHEMA_COLLECTION, {
    vectors: {
      size: QDRANT_CONFIG.VECTOR_SIZE,
      distance: QDRANT_CONFIG.DISTANCE_METRIC,
    },
  });

  // Create payload indexes for schema collection
  await qdrantClient.createPayloadIndex(QDRANT_CONFIG.SCHEMA_COLLECTION, {
    field_name: 'table',
    field_schema: 'keyword',
  });

  await qdrantClient.createPayloadIndex(QDRANT_CONFIG.SCHEMA_COLLECTION, {
    field_name: 'code',
    field_schema: 'keyword',
  });

  console.error(`[Vector] Created schema collection '${QDRANT_CONFIG.SCHEMA_COLLECTION}'`);
  return true;
}

/**
 * Create the data collection (crm_data)
 */
export async function createDataCollection(): Promise<boolean> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const exists = await collectionExists(QDRANT_CONFIG.DATA_COLLECTION);
  if (exists) {
    console.error(`[Vector] Data collection '${QDRANT_CONFIG.DATA_COLLECTION}' already exists`);
    return false;
  }

  await qdrantClient.createCollection(QDRANT_CONFIG.DATA_COLLECTION, {
    vectors: {
      size: QDRANT_CONFIG.VECTOR_SIZE,
      distance: QDRANT_CONFIG.DISTANCE_METRIC,
    },
  });

  // Create payload indexes for filtering
  const indexFields = [
    { field: 'stage_id', type: 'integer' as const },
    { field: 'user_id', type: 'integer' as const },
    { field: 'team_id', type: 'integer' as const },
    { field: 'expected_revenue', type: 'float' as const },
    { field: 'is_won', type: 'bool' as const },
    { field: 'is_lost', type: 'bool' as const },
    { field: 'is_active', type: 'bool' as const },
    { field: 'sector', type: 'keyword' as const },
    { field: 'entity_type', type: 'keyword' as const },
  ];

  for (const { field, type } of indexFields) {
    try {
      await qdrantClient.createPayloadIndex(QDRANT_CONFIG.DATA_COLLECTION, {
        field_name: field,
        field_schema: type,
      });
    } catch {
      // Index might already exist
    }
  }

  console.error(`[Vector] Created data collection '${QDRANT_CONFIG.DATA_COLLECTION}'`);
  return true;
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
// SCHEMA COLLECTION OPERATIONS
// =============================================================================

/**
 * Upsert schema definitions to crm_schema collection
 */
export async function upsertSchemaPoints(
  points: Array<{
    id: string;  // Schema code like "O_1"
    vector: number[];
    payload: SchemaVector;
  }>
): Promise<void> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  // Convert string IDs to integers (hash-based)
  const qdrantPoints = points.map(p => ({
    id: hashSchemaCode(p.id),
    vector: p.vector,
    payload: p.payload as unknown as Record<string, unknown>,
  }));

  await qdrantClient.upsert(QDRANT_CONFIG.SCHEMA_COLLECTION, {
    wait: true,
    points: qdrantPoints,
  });
}

/**
 * Search schema collection by vector
 */
export async function searchSchemaCollection(
  vector: number[],
  limit: number = 10,
  tableFilter?: string
): Promise<Array<{ code: string; score: number; payload: SchemaVector }>> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const filter = tableFilter
    ? { must: [{ key: 'table', match: { value: tableFilter } }] }
    : undefined;

  const results = await qdrantClient.search(QDRANT_CONFIG.SCHEMA_COLLECTION, {
    vector,
    limit,
    filter,
    with_payload: true,
  });

  return results.map(r => ({
    code: (r.payload as Record<string, unknown>).code as string,
    score: r.score,
    payload: r.payload as unknown as SchemaVector,
  }));
}

// =============================================================================
// DATA COLLECTION OPERATIONS
// =============================================================================

/**
 * Upsert opportunity records to crm_data collection
 */
export async function upsertDataPoints(
  points: Array<{
    id: number;  // Odoo ID
    vector: number[];
    payload: OpportunityPayload;
  }>
): Promise<void> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  await qdrantClient.upsert(QDRANT_CONFIG.DATA_COLLECTION, {
    wait: true,
    points: points.map(p => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload as unknown as Record<string, unknown>,
    })),
  });
}

/**
 * Search data collection with optional filters
 */
export async function searchDataCollection(
  vector: number[],
  options: {
    limit?: number;
    minScore?: number;
    filter?: VectorFilter;
  } = {}
): Promise<VectorSearchResult[]> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const { limit = 10, minScore = SIMILARITY_THRESHOLDS.DEFAULT_MIN, filter } = options;

  const qdrantFilter = filter ? buildQdrantFilter(filter) : undefined;

  const results = await qdrantClient.search(QDRANT_CONFIG.DATA_COLLECTION, {
    vector,
    limit,
    score_threshold: minScore,
    filter: qdrantFilter,
    with_payload: true,
  });

  return results.map(r => ({
    id: r.id as number,
    score: r.score,
    payload: r.payload as unknown as OpportunityPayload,
  }));
}

/**
 * Delete all points from data collection (for full sync)
 */
export async function clearDataCollection(): Promise<void> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  // Delete collection and recreate
  try {
    await qdrantClient.deleteCollection(QDRANT_CONFIG.DATA_COLLECTION);
  } catch {
    // Collection might not exist
  }

  await createDataCollection();
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Convert schema code to numeric ID for Qdrant
 */
function hashSchemaCode(code: string): number {
  // Simple hash: prefix_number mapping
  const prefixMap: Record<string, number> = {
    'O': 1000,
    'C': 2000,
    'S': 3000,
    'U': 4000,
    'T': 5000,
    'ST': 6000,
    'LR': 7000,
  };

  const parts = code.split('_');
  const prefix = parts[0];
  const num = parseInt(parts[1], 10) || 0;

  return (prefixMap[prefix] || 0) + num;
}

/**
 * Build Qdrant filter from VectorFilter
 */
function buildQdrantFilter(filter: VectorFilter): { must: object[] } {
  const must: object[] = [];

  if (filter.stage_id !== undefined) {
    if (typeof filter.stage_id === 'number') {
      must.push({ key: 'stage_id', match: { value: filter.stage_id } });
    } else if (filter.stage_id.$in) {
      must.push({ key: 'stage_id', match: { any: filter.stage_id.$in } });
    }
  }

  if (filter.user_id !== undefined) {
    if (typeof filter.user_id === 'number') {
      must.push({ key: 'user_id', match: { value: filter.user_id } });
    } else if (filter.user_id.$in) {
      must.push({ key: 'user_id', match: { any: filter.user_id.$in } });
    }
  }

  if (filter.team_id !== undefined) {
    must.push({ key: 'team_id', match: { value: filter.team_id } });
  }

  if (filter.is_won !== undefined) {
    must.push({ key: 'is_won', match: { value: filter.is_won } });
  }

  if (filter.is_lost !== undefined) {
    must.push({ key: 'is_lost', match: { value: filter.is_lost } });
  }

  if (filter.is_active !== undefined) {
    must.push({ key: 'is_active', match: { value: filter.is_active } });
  }

  if (filter.sector !== undefined) {
    must.push({ key: 'sector', match: { value: filter.sector } });
  }

  if (filter.expected_revenue !== undefined) {
    const range: { gte?: number; lte?: number } = {};
    if (filter.expected_revenue.$gte !== undefined) range.gte = filter.expected_revenue.$gte;
    if (filter.expected_revenue.$lte !== undefined) range.lte = filter.expected_revenue.$lte;
    must.push({ key: 'expected_revenue', range });
  }

  return { must };
}
