/**
 * Data Sync Service
 *
 * Orchestrates the sync of Odoo table data to the vector database.
 * Handles: schema validation, data fetching, encoding, embedding, and upsert.
 *
 * Key features:
 * - Full table sync (all records including archived)
 * - Schema validation before sync
 * - Batch processing for embedding and upsert
 * - Progress reporting
 */

import { getOdooClient } from './odoo-client.js';
import { embedBatch, isEmbeddingServiceAvailable } from './embedding-service.js';
import { getQdrantClient, isVectorClientAvailable } from './vector-client.js';
import {
  getModelFields,
  buildFieldEncodingMap,
  validateSchemaDataAlignment,
  transformRecords,
  getFieldsToFetch,
} from './data-transformer.js';
import { DATA_TRANSFORM_CONFIG, QDRANT_CONFIG } from '../constants.js';
import type {
  DataTransformConfig,
  DataSyncResult,
  DataPoint,
  DataPayload,
  ValidationResult,
} from '../types.js';

// =============================================================================
// POINT ID GENERATION
// =============================================================================

/**
 * Generate unique point ID for a data record
 *
 * Strategy: model_id * 10_000_000 + record_id
 * This ensures no collision with schema field_ids (which are < 100,000)
 *
 * Example: crm.lead (344) record 12345 = 3440012345
 */
export function generateDataPointId(modelId: number, recordId: number): number {
  return modelId * DATA_TRANSFORM_CONFIG.MODEL_ID_MULTIPLIER + recordId;
}

// =============================================================================
// DATA FETCHING
// =============================================================================

/**
 * Fetch all records from Odoo with pagination
 *
 * @param config - Transform configuration
 * @param fields - Fields to fetch
 * @param onProgress - Progress callback
 * @returns Array of raw Odoo records
 */
export async function fetchAllRecords(
  config: DataTransformConfig,
  fields: string[],
  onProgress?: (current: number, total: number) => void
): Promise<Record<string, unknown>[]> {
  const client = getOdooClient();
  const allRecords: Record<string, unknown>[] = [];
  const batchSize = DATA_TRANSFORM_CONFIG.FETCH_BATCH_SIZE;

  // Build domain filter
  const domain: unknown[] = [];

  // Context to include archived records
  const context: Record<string, unknown> = {};
  if (config.include_archived !== false) {
    context.active_test = false; // Include active=false records
  }

  // Get total count first
  const total = config.test_limit
    ? Math.min(config.test_limit, await client.searchCount(config.model_name, domain, context))
    : await client.searchCount(config.model_name, domain, context);

  console.error(`[DataSync] Fetching ${total} records from ${config.model_name}`);

  if (onProgress) {
    onProgress(0, total);
  }

  // Fetch in batches
  let offset = 0;
  const maxRecords = config.test_limit || total;

  while (offset < maxRecords) {
    const limit = Math.min(batchSize, maxRecords - offset);

    const batch = await client.searchRead<Record<string, unknown>>(
      config.model_name,
      domain,
      fields,
      { limit, offset, order: 'id', context }
    );

    allRecords.push(...batch);
    offset += batch.length;

    if (onProgress) {
      onProgress(allRecords.length, total);
    }

    // Break if no more records
    if (batch.length < limit) break;
  }

  return allRecords;
}

// =============================================================================
// DATA UPSERT
// =============================================================================

/**
 * Upsert data points to Qdrant
 */
async function upsertDataPoints(points: DataPoint[]): Promise<void> {
  const client = getQdrantClient();

  await client.upsert(QDRANT_CONFIG.COLLECTION, {
    wait: true,
    points: points.map(p => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload as unknown as Record<string, unknown>,
    })),
  });
}

/**
 * Create payload indexes for data points (if not exists)
 */
async function ensureDataIndexes(): Promise<void> {
  const client = getQdrantClient();

  const indexFields = [
    { field: 'record_id', type: 'integer' as const },
    { field: 'point_type', type: 'keyword' as const },
  ];

  for (const { field, type } of indexFields) {
    try {
      await client.createPayloadIndex(QDRANT_CONFIG.COLLECTION, {
        field_name: field,
        field_schema: type,
      });
    } catch {
      // Index might already exist - ignore
    }
  }
}

// =============================================================================
// MAIN SYNC FUNCTION
// =============================================================================

/**
 * Progress callback type
 */
export type ProgressCallback = (phase: string, current: number, total: number) => void;

/**
 * Sync model data to Qdrant
 *
 * This is the main orchestration function that:
 * 1. Validates schema-data alignment
 * 2. Fetches all records from Odoo
 * 3. Encodes records into coordinate format
 * 4. Generates embeddings
 * 5. Upserts to Qdrant
 *
 * @param config - Transform configuration
 * @param onProgress - Progress callback
 * @returns Sync result
 */
export async function syncModelData(
  config: DataTransformConfig,
  onProgress?: ProgressCallback
): Promise<DataSyncResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  // Validate services are available
  if (!isEmbeddingServiceAvailable()) {
    return {
      success: false,
      model_name: config.model_name,
      records_processed: 0,
      records_embedded: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
      errors: ['Embedding service not available. Set VOYAGE_API_KEY.'],
    };
  }

  if (!isVectorClientAvailable()) {
    return {
      success: false,
      model_name: config.model_name,
      records_processed: 0,
      records_embedded: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
      errors: ['Vector client not available. Check QDRANT_HOST.'],
    };
  }

  try {
    // Phase 1: Load schema and build encoding map
    onProgress?.('loading_schema', 0, 1);
    console.error(`[DataSync] Loading schema for ${config.model_name}`);

    const schemaFields = getModelFields(config.model_name);
    if (schemaFields.length === 0) {
      return {
        success: false,
        model_name: config.model_name,
        records_processed: 0,
        records_embedded: 0,
        records_failed: 0,
        duration_ms: Date.now() - startTime,
        errors: [`No schema found for model: ${config.model_name}`],
      };
    }

    console.error(`[DataSync] Found ${schemaFields.length} schema fields for ${config.model_name}`);
    const encodingMap = buildFieldEncodingMap(schemaFields);

    // Phase 2: Fetch sample record and validate schema alignment
    onProgress?.('validating', 0, 1);
    console.error(`[DataSync] Validating schema-data alignment`);

    const fieldsToFetch = getFieldsToFetch(encodingMap);

    // Fetch first record to validate fields
    const sampleRecords = await fetchAllRecords(
      { ...config, test_limit: 1 },
      fieldsToFetch
    );

    if (sampleRecords.length === 0) {
      return {
        success: false,
        model_name: config.model_name,
        records_processed: 0,
        records_embedded: 0,
        records_failed: 0,
        duration_ms: Date.now() - startTime,
        errors: [`No records found for model: ${config.model_name}`],
      };
    }

    // Validate schema-data alignment
    const odooFields = Object.keys(sampleRecords[0]);
    const validation: ValidationResult = validateSchemaDataAlignment(odooFields, schemaFields);

    if (!validation.valid) {
      return {
        success: false,
        model_name: config.model_name,
        records_processed: 0,
        records_embedded: 0,
        records_failed: 0,
        duration_ms: Date.now() - startTime,
        errors: [
          `Schema-Data mismatch! ${validation.missing_in_schema.length} Odoo fields not in schema:`,
          ...validation.missing_in_schema.slice(0, 20), // Show first 20
          validation.missing_in_schema.length > 20
            ? `... and ${validation.missing_in_schema.length - 20} more`
            : '',
          '',
          'Please update schema first (sync schema), then retry data sync.',
        ].filter(Boolean),
      };
    }

    console.error(`[DataSync] Schema validation passed: ${validation.matched_fields.length} fields matched`);

    // Phase 3: Fetch all records
    onProgress?.('fetching', 0, 1);
    console.error(`[DataSync] Fetching all records from Odoo`);

    const records = await fetchAllRecords(config, fieldsToFetch, (cur, tot) => {
      onProgress?.('fetching', cur, tot);
    });

    console.error(`[DataSync] Fetched ${records.length} records`);

    // Phase 4: Transform records to encoded strings
    onProgress?.('encoding', 0, records.length);
    console.error(`[DataSync] Encoding records`);

    const encodedRecords = transformRecords(records, encodingMap, config);

    console.error(`[DataSync] Encoded ${encodedRecords.length} records`);

    // Phase 5: Generate embeddings and upsert in batches
    const embedBatchSize = DATA_TRANSFORM_CONFIG.EMBED_BATCH_SIZE;
    let totalEmbedded = 0;

    // Ensure indexes exist for data points
    await ensureDataIndexes();

    for (let i = 0; i < encodedRecords.length; i += embedBatchSize) {
      const batch = encodedRecords.slice(i, i + embedBatchSize);

      onProgress?.('embedding', i, encodedRecords.length);

      try {
        // Generate embeddings for encoded strings
        const texts = batch.map(r => r.encoded_string);
        const embeddings = await embedBatch(texts, 'document');

        // Build data points for upsert
        const points: DataPoint[] = batch.map((record, idx) => ({
          id: generateDataPointId(record.model_id, record.record_id),
          vector: embeddings[idx],
          payload: {
            record_id: record.record_id,
            model_name: record.model_name,
            model_id: record.model_id,
            encoded_string: record.encoded_string,
            field_count: record.field_count,
            sync_timestamp: new Date().toISOString(),
            point_type: 'data' as const,
          } as DataPayload,
        }));

        // Upsert to Qdrant
        await upsertDataPoints(points);
        totalEmbedded += batch.length;

        console.error(`[DataSync] Embedded and upserted batch ${i / embedBatchSize + 1}: ${batch.length} records`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        errors.push(`Batch ${i / embedBatchSize + 1} failed: ${errMsg}`);
        console.error(`[DataSync] Batch error:`, errMsg);
      }
    }

    onProgress?.('complete', encodedRecords.length, encodedRecords.length);

    return {
      success: errors.length === 0,
      model_name: config.model_name,
      records_processed: records.length,
      records_embedded: totalEmbedded,
      records_failed: records.length - totalEmbedded,
      duration_ms: Date.now() - startTime,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      model_name: config.model_name,
      records_processed: 0,
      records_embedded: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
      errors: [errMsg],
    };
  }
}

/**
 * Get data sync status
 */
export async function getDataSyncStatus(): Promise<{
  collection: string;
  total_points: number;
  schema_points: number;
  data_points: number;
}> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not available');
  }

  const client = getQdrantClient();

  try {
    const info = await client.getCollection(QDRANT_CONFIG.COLLECTION);
    const totalPoints = info.points_count ?? 0;

    // Count data points specifically
    const dataCount = await client.count(QDRANT_CONFIG.COLLECTION, {
      filter: {
        must: [{ key: 'point_type', match: { value: 'data' } }],
      },
      exact: true,
    });

    return {
      collection: QDRANT_CONFIG.COLLECTION,
      total_points: totalPoints,
      schema_points: totalPoints - dataCount.count,
      data_points: dataCount.count,
    };
  } catch {
    return {
      collection: QDRANT_CONFIG.COLLECTION,
      total_points: 0,
      schema_points: 0,
      data_points: 0,
    };
  }
}
