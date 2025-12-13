/**
 * Schema Service
 *
 * Manages the crm_schema collection - the self-describing part of the architecture.
 * This service enables AI Schema Discovery: Claude can semantically search for
 * field meanings without hardcoded lookups.
 *
 * Example: "find fields about revenue" → O_10 (expected_revenue)
 */

import { SCHEMA_DEFINITIONS, QDRANT_CONFIG } from '../constants.js';
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

  // Build schema vectors
  const schemaCodes = Object.keys(SCHEMA_DEFINITIONS);
  const schemaVectors: SchemaVector[] = schemaCodes.map(code => {
    const def = SCHEMA_DEFINITIONS[code];
    return {
      id: code,
      code: code,
      table: def.table,
      field: def.field,
      type: def.type,
      semantic: def.semantic,
    };
  });

  // Build semantic texts for embedding
  // Format: "CODE from TABLE field FIELD: SEMANTIC_DESCRIPTION"
  const semanticTexts = schemaVectors.map(sv =>
    `${sv.code} from ${sv.table} field ${sv.field}: ${sv.semantic}`
  );

  console.error(`[Schema] Generating embeddings for ${semanticTexts.length} schema definitions...`);

  // Generate embeddings (use 'document' type since we're indexing)
  const embeddings = await embedBatch(semanticTexts, 'document', (current, total) => {
    console.error(`[Schema] Embedding progress: ${current}/${total}`);
  });

  // Prepare points for upsert
  const points = schemaVectors.map((sv, idx) => ({
    id: sv.code,
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
 * - "fields about revenue or money" → O_10 (expected_revenue)
 * - "contact information" → C_10 (email), C_11 (phone)
 * - "pipeline stage" → S_1 (stage name)
 *
 * @param query Natural language query
 * @param options Search options
 */
export async function searchSchema(
  query: string,
  options: {
    limit?: number;
    tableFilter?: string;  // Filter to specific table like "crm.lead"
  } = {}
): Promise<SchemaSearchResult[]> {
  const { limit = 10, tableFilter } = options;

  // Check if embedding service is available
  if (!isEmbeddingServiceAvailable()) {
    throw new Error('Embedding service not available');
  }

  // Generate query embedding (use 'query' type for search)
  const queryVector = await embed(query, 'query');

  // Search schema collection
  const results = await searchSchemaCollection(queryVector, limit, tableFilter);

  // Map to SchemaSearchResult
  return results.map(r => ({
    code: r.payload.code,
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
 * Get schema definition by code
 */
export function getSchemaByCode(code: string): SchemaVector | undefined {
  const def = SCHEMA_DEFINITIONS[code];
  if (!def) return undefined;

  return {
    id: code,
    code: code,
    table: def.table,
    field: def.field,
    type: def.type,
    semantic: def.semantic,
  };
}

/**
 * Get all schema codes for a specific table
 */
export function getSchemaByTable(table: string): SchemaVector[] {
  return Object.entries(SCHEMA_DEFINITIONS)
    .filter(([_, def]) => def.table === table)
    .map(([code, def]) => ({
      id: code,
      code: code,
      table: def.table,
      field: def.field,
      type: def.type,
      semantic: def.semantic,
    }));
}

/**
 * Get all schema definitions
 */
export function getAllSchema(): SchemaVector[] {
  return Object.entries(SCHEMA_DEFINITIONS).map(([code, def]) => ({
    id: code,
    code: code,
    table: def.table,
    field: def.field,
    type: def.type,
    semantic: def.semantic,
  }));
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
    definitionCount: Object.keys(SCHEMA_DEFINITIONS).length,
  };
}
