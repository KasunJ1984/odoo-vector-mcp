/**
 * Vector Client
 *
 * Manages two Qdrant collections:
 * - crm_schema: Schema definitions with semantic embeddings
 * - crm_data: Opportunity records with encoded strings
 *
 * NEW FORMAT: Uses numeric table^column codes (e.g., 1^10)
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { QDRANT_CONFIG, SIMILARITY_THRESHOLDS, ENCODING_CONFIG } from '../constants.js';
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

  // Index for table_number (NEW)
  await qdrantClient.createPayloadIndex(QDRANT_CONFIG.SCHEMA_COLLECTION, {
    field_name: 'table_number',
    field_schema: 'integer',
  });

  // Index for id (schema code like "1^10")
  await qdrantClient.createPayloadIndex(QDRANT_CONFIG.SCHEMA_COLLECTION, {
    field_name: 'id',
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
    // Core indexes
    { field: 'stage_id', type: 'integer' as const },
    { field: 'user_id', type: 'integer' as const },
    { field: 'team_id', type: 'integer' as const },
    { field: 'expected_revenue', type: 'float' as const },
    { field: 'is_won', type: 'bool' as const },
    { field: 'is_lost', type: 'bool' as const },
    { field: 'is_active', type: 'bool' as const },
    { field: 'sector', type: 'keyword' as const },
    { field: 'entity_type', type: 'keyword' as const },
    // New indexes for tables 8-10
    { field: 'specification_id', type: 'integer' as const },
    { field: 'lead_source_id', type: 'integer' as const },
    { field: 'architect_id', type: 'integer' as const },
    // Text indexes for names
    { field: 'opportunity_name', type: 'keyword' as const },
    { field: 'contact_name', type: 'keyword' as const },
    { field: 'stage_name', type: 'keyword' as const },
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
    id: string;  // Schema code like "1^10"
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
 *
 * @param vector Query vector
 * @param limit Max results
 * @param tableFilter Filter by table name (e.g., "crm.lead")
 * @param tableNumberFilter Filter by table number (e.g., 1)
 */
export async function searchSchemaCollection(
  vector: number[],
  limit: number = 10,
  tableFilter?: string,
  tableNumberFilter?: number
): Promise<Array<{ code: string; score: number; payload: SchemaVector }>> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  // Build filter conditions
  const mustConditions: object[] = [];

  if (tableFilter) {
    mustConditions.push({ key: 'table', match: { value: tableFilter } });
  }

  if (tableNumberFilter !== undefined) {
    mustConditions.push({ key: 'table_number', match: { value: tableNumberFilter } });
  }

  const filter = mustConditions.length > 0 ? { must: mustConditions } : undefined;

  const results = await qdrantClient.search(QDRANT_CONFIG.SCHEMA_COLLECTION, {
    vector,
    limit,
    filter,
    with_payload: true,
  });

  return results.map(r => ({
    code: (r.payload as Record<string, unknown>).id as string,
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
 *
 * NEW FORMAT: "1^10" → (table * 1000) + column
 * Example: "1^10" → 1010, "2^1" → 2001
 */
function hashSchemaCode(code: string): number {
  const caretIndex = code.indexOf(ENCODING_CONFIG.CODE_DELIMITER);
  if (caretIndex === -1) {
    // Fallback: try to parse the whole thing as a number
    const num = parseInt(code, 10);
    return isNaN(num) ? 0 : num;
  }

  const tableNumber = parseInt(code.substring(0, caretIndex), 10);
  const columnNumber = parseInt(code.substring(caretIndex + 1), 10);

  if (isNaN(tableNumber) || isNaN(columnNumber)) {
    return 0;
  }

  // Hash: table * 1000 + column
  // This gives unique IDs for all combinations (up to 999 columns per table)
  return (tableNumber * 1000) + columnNumber;
}

/**
 * Build Qdrant filter from VectorFilter
 */
function buildQdrantFilter(filter: VectorFilter): { must: object[] } {
  const must: object[] = [];

  // Core filters
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

  // New filters for tables 8-10
  if (filter.specification_id !== undefined) {
    must.push({ key: 'specification_id', match: { value: filter.specification_id } });
  }

  if (filter.lead_source_id !== undefined) {
    must.push({ key: 'lead_source_id', match: { value: filter.lead_source_id } });
  }

  if (filter.architect_id !== undefined) {
    must.push({ key: 'architect_id', match: { value: filter.architect_id } });
  }

  return { must };
}
