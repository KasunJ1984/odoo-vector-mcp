/**
 * Schema Service
 *
 * Manages the crm_schema collection - the self-describing part of the architecture.
 * This service enables AI Schema Discovery: Claude can semantically search for
 * field meanings without hardcoded lookups.
 *
 * NEW FORMAT: {TABLE_NUMBER}^{COLUMN_NUMBER}
 * Example: "find fields about revenue" → 1^10 (expected_revenue)
 */

import {
  SCHEMA_DEFINITIONS,
  QDRANT_CONFIG,
  getSchemaCode,
  getSchemaByCode as getSchemaDefByCode,
  TABLE_DISPLAY_NAMES,
} from '../constants.js';
import { embed, embedBatch, isEmbeddingServiceAvailable } from './embedding-service.js';
import {
  collectionExists,
  createSchemaCollection,
  upsertSchemaPoints,
  searchSchemaCollection,
  getCollectionInfo,
} from './vector-client.js';
import type { SchemaVector, SchemaSearchResult } from '../types.js';

// =============================================================================
// SCHEMA INITIALIZATION
// =============================================================================

/**
 * Initialize the schema collection with all schema definitions.
 *
 * This embeds each schema definition's semantic description, allowing
 * Claude to discover field meanings through natural language queries.
 *
 * @returns Result of initialization
 */
export async function initializeSchemaCollection(): Promise<{
  created: boolean;
  schemaCount: number;
  message: string;
}> {
  // Check if embedding service is available
  if (!isEmbeddingServiceAvailable()) {
    return {
      created: false,
      schemaCount: 0,
      message: 'Embedding service not available',
    };
  }

  // Check if collection already exists with data
  const exists = await collectionExists(QDRANT_CONFIG.SCHEMA_COLLECTION);
  if (exists) {
    const info = await getCollectionInfo(QDRANT_CONFIG.SCHEMA_COLLECTION);
    if (info.vectorCount > 0) {
      return {
        created: false,
        schemaCount: info.vectorCount,
        message: `Schema collection already exists with ${info.vectorCount} definitions`,
      };
    }
  }

  // Create collection if needed
  if (!exists) {
    await createSchemaCollection();
  }

  // Build schema vectors from the array of definitions
  const schemaVectors: SchemaVector[] = SCHEMA_DEFINITIONS.map(def => {
    const code = getSchemaCode(def);
    return {
      id: code,
      table_number: def.table_number,
      column_number: def.column_number,
      table: def.table,
      field: def.field,
      type: def.type,
      semantic: def.semantic,
    };
  });

  // Build semantic texts for embedding
  // Format: "CODE (TABLE_NAME) from TABLE field FIELD: SEMANTIC_DESCRIPTION"
  const semanticTexts = schemaVectors.map(sv => {
    const tableName = TABLE_DISPLAY_NAMES[sv.table_number] || sv.table;
    return `${sv.id} (${tableName}) from ${sv.table} field ${sv.field}: ${sv.semantic}`;
  });

  console.error(`[Schema] Generating embeddings for ${semanticTexts.length} schema definitions...`);

  // Generate embeddings (use 'document' type since we're indexing)
  const embeddings = await embedBatch(semanticTexts, 'document', (current, total) => {
    console.error(`[Schema] Embedding progress: ${current}/${total}`);
  });

  // Prepare points for upsert
  const points = schemaVectors.map((sv, idx) => ({
    id: sv.id,
    vector: embeddings[idx],
    payload: sv,
  }));

  // Upsert to collection
  await upsertSchemaPoints(points);

  console.error(`[Schema] Initialized schema collection with ${points.length} definitions`);

  return {
    created: true,
    schemaCount: points.length,
    message: `Schema collection initialized with ${points.length} definitions`,
  };
}

// =============================================================================
// SCHEMA SEARCH (AI Schema Discovery)
// =============================================================================

/**
 * Search schema by semantic meaning.
 *
 * This is the KEY INNOVATION - Claude can discover field meanings
 * by asking natural language questions.
 *
 * Examples:
 * - "fields about revenue or money" → 1^10 (expected_revenue)
 * - "contact information" → 2^10 (email), 2^11 (phone)
 * - "pipeline stage" → 3^1 (stage name)
 *
 * @param query Natural language query
 * @param options Search options
 */
export async function searchSchema(
  query: string,
  options: {
    limit?: number;
    tableFilter?: string;  // Filter to specific table like "crm.lead"
    tableNumberFilter?: number;  // Filter by table number (NEW)
  } = {}
): Promise<SchemaSearchResult[]> {
  const { limit = 10, tableFilter, tableNumberFilter } = options;

  // Check if embedding service is available
  if (!isEmbeddingServiceAvailable()) {
    throw new Error('Embedding service not available');
  }

  // Generate query embedding (use 'query' type for search)
  const queryVector = await embed(query, 'query');

  // Search schema collection
  const results = await searchSchemaCollection(queryVector, limit, tableFilter, tableNumberFilter);

  // Map to SchemaSearchResult with table_number and column_number
  return results.map(r => ({
    code: r.payload.id,
    table_number: r.payload.table_number,
    column_number: r.payload.column_number,
    table: r.payload.table,
    field: r.payload.field,
    type: r.payload.type,
    semantic: r.payload.semantic,
    score: r.score,
  }));
}

// =============================================================================
// SCHEMA LOOKUP
// =============================================================================

/**
 * Get schema definition by code string
 * @param code Schema code like "1^10"
 */
export function getSchemaByCode(code: string): SchemaVector | undefined {
  const def = getSchemaDefByCode(code);
  if (!def) return undefined;

  return {
    id: code,
    table_number: def.table_number,
    column_number: def.column_number,
    table: def.table,
    field: def.field,
    type: def.type,
    semantic: def.semantic,
  };
}

/**
 * Get all schema codes for a specific table number
 */
export function getSchemaByTableNumber(tableNumber: number): SchemaVector[] {
  return SCHEMA_DEFINITIONS
    .filter(def => def.table_number === tableNumber)
    .map(def => {
      const code = getSchemaCode(def);
      return {
        id: code,
        table_number: def.table_number,
        column_number: def.column_number,
        table: def.table,
        field: def.field,
        type: def.type,
        semantic: def.semantic,
      };
    });
}

/**
 * Get all schema codes for a specific table name
 */
export function getSchemaByTable(table: string): SchemaVector[] {
  return SCHEMA_DEFINITIONS
    .filter(def => def.table === table)
    .map(def => {
      const code = getSchemaCode(def);
      return {
        id: code,
        table_number: def.table_number,
        column_number: def.column_number,
        table: def.table,
        field: def.field,
        type: def.type,
        semantic: def.semantic,
      };
    });
}

/**
 * Get all schema definitions
 */
export function getAllSchema(): SchemaVector[] {
  return SCHEMA_DEFINITIONS.map(def => {
    const code = getSchemaCode(def);
    return {
      id: code,
      table_number: def.table_number,
      column_number: def.column_number,
      table: def.table,
      field: def.field,
      type: def.type,
      semantic: def.semantic,
    };
  });
}

/**
 * Get schema collection status
 */
export async function getSchemaStatus(): Promise<{
  exists: boolean;
  vectorCount: number;
  definitionCount: number;
}> {
  const info = await getCollectionInfo(QDRANT_CONFIG.SCHEMA_COLLECTION);
  return {
    exists: info.exists,
    vectorCount: info.vectorCount,
    definitionCount: SCHEMA_DEFINITIONS.length,
  };
}
