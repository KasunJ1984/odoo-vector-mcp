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
import { getSchemasByModel, getAllModelNames } from './schema-loader.js';
import { DATA_TRANSFORM_CONFIG, QDRANT_CONFIG } from '../constants.js';
import type {
  DataTransformConfig,
  DataSyncResult,
  DataSyncResultWithRestrictions,
  DataPoint,
  DataPayload,
  ValidationResult,
  FieldRestriction,
  FieldRestrictionReason,
  EncodingContext,
} from '../types.js';

// =============================================================================
// DYNAMIC MODEL CONFIGURATION DISCOVERY
// =============================================================================

/**
 * Discovered model configuration from schema
 */
export interface DiscoveredModelConfig {
  model_name: string;
  model_id: number;
  id_field_id: number;
  field_count: number;
}

/**
 * Extract model name from the transfer command
 *
 * Format: "transfer_[model.name]_1984"
 * Examples:
 * - "transfer_crm.lead_1984" → "crm.lead"
 * - "transfer_res.partner_1984" → "res.partner"
 * - "transfer_sale.order_1984" → "sale.order"
 *
 * @param command - The full transfer command
 * @returns Extracted model name
 */
export function extractModelNameFromCommand(command: string): string {
  // Pattern: transfer_[model.name]_1984
  // Remove "transfer_" prefix and "_1984" suffix
  const match = command.match(/^transfer_(.+)_1984$/);
  if (!match) {
    throw new Error(`Invalid command format: ${command}. Expected: transfer_[model.name]_1984`);
  }
  return match[1];
}

/**
 * Discover model configuration from schema
 *
 * Dynamically extracts model_id and id_field_id from the schema data.
 * This allows ANY model to be synced without hardcoding configurations.
 *
 * How it works:
 * 1. Get all schema fields for the model
 * 2. Extract model_id from any field (all fields in a model have the same model_id)
 * 3. Find the 'id' field and get its field_id
 *
 * @param modelName - Odoo model name (e.g., "res.partner")
 * @returns DiscoveredModelConfig with model_id and id_field_id
 * @throws Error if model not found in schema
 */
export function discoverModelConfig(modelName: string): DiscoveredModelConfig {
  console.error(`[DataSync] Discovering config for model: ${modelName}`);

  // Get all fields for this model from schema
  const modelFields = getSchemasByModel(modelName);

  if (modelFields.length === 0) {
    // Get list of available models to help user
    const availableModels = getAllModelNames();
    const similarModels = availableModels
      .filter(m => m.includes(modelName.split('.')[0]) || modelName.includes(m.split('.')[0]))
      .slice(0, 5);

    throw new Error(
      `Model "${modelName}" not found in schema.\n` +
      `Total models in schema: ${availableModels.length}\n` +
      (similarModels.length > 0
        ? `Similar models: ${similarModels.join(', ')}`
        : `Run schema sync first to populate the schema.`)
    );
  }

  // Extract model_id from first field (all fields in same model have same model_id)
  const model_id = modelFields[0].model_id;

  // Find the 'id' field to get its field_id
  const idField = modelFields.find(f => f.field_name === 'id');
  if (!idField) {
    throw new Error(
      `Model "${modelName}" does not have an 'id' field in schema.\n` +
      `Found ${modelFields.length} fields, but none named 'id'.\n` +
      `This may indicate incomplete schema data.`
    );
  }

  const config: DiscoveredModelConfig = {
    model_name: modelName,
    model_id: model_id,
    id_field_id: idField.field_id,
    field_count: modelFields.length,
  };

  console.error(`[DataSync] Discovered config for ${modelName}:`);
  console.error(`  - model_id: ${config.model_id}`);
  console.error(`  - id_field_id: ${config.id_field_id}`);
  console.error(`  - field_count: ${config.field_count}`);

  return config;
}

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

    // Log progress every batch
    const pct = Math.round((allRecords.length / total) * 100);
    console.error(`[DataSync] Fetched ${allRecords.length}/${total} records (${pct}%)`);

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
 * Sync model data to Qdrant using STREAMING approach
 *
 * IMPORTANT: Uses streaming to avoid memory issues with large tables.
 * Each batch is: Fetch → Encode → Embed → Upsert → Clear
 * This keeps memory usage constant regardless of table size.
 *
 * **RESILIENT FIELD HANDLING:**
 * When API permissions restrict access to certain fields, the sync continues
 * gracefully by:
 * 1. Detecting restricted fields from error messages
 * 2. Removing them from the query
 * 3. Encoding them as "Restricted_from_API"
 * 4. Reporting which fields were restricted in the result
 *
 * @param config - Transform configuration
 * @param onProgress - Progress callback
 * @returns Sync result with restriction information
 */
export async function syncModelData(
  config: DataTransformConfig,
  onProgress?: ProgressCallback
): Promise<DataSyncResultWithRestrictions> {
  const startTime = Date.now();
  const errors: string[] = [];
  const warnings: string[] = [];

  // Track restricted fields discovered during sync (Map: field → reason)
  const restrictedFieldsMap = new Map<string, FieldRestrictionReason>();

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
      restricted_fields: [],
      warnings: [],
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
      restricted_fields: [],
      warnings: [],
    };
  }

  try {
    // Get Odoo client
    const client = getOdooClient();

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
        restricted_fields: [],
        warnings: [],
      };
    }

    console.error(`[DataSync] Found ${schemaFields.length} schema fields for ${config.model_name}`);
    const encodingMap = buildFieldEncodingMap(schemaFields);
    const fieldsToFetch = getFieldsToFetch(encodingMap);

    // Phase 2: Fetch sample record with resilient handling and validate schema alignment
    onProgress?.('validating', 0, 1);
    console.error(`[DataSync] Validating schema-data alignment (with resilient field handling)`);

    // Track fields we'll actually fetch (may be reduced if some are restricted)
    let currentFieldsToFetch = [...fieldsToFetch];

    // Build domain and context for queries
    const domain: unknown[] = [];
    const context: Record<string, unknown> = {};
    if (config.include_archived !== false) {
      context.active_test = false;
    }

    // Use resilient fetch for sample record to discover any restricted fields
    const sampleResult = await client.searchReadWithRetry<Record<string, unknown>>(
      config.model_name,
      domain,
      currentFieldsToFetch,
      { limit: 1, context },
      {
        maxRetries: 5,
        onFieldRestricted: (field, reason) => {
          restrictedFieldsMap.set(field, reason);
          const marker = reason === 'odoo_error' ? 'Restricted_odoo_error' : 'Restricted_from_API';
          warnings.push(`Field '${field}' restricted (${reason}) - will be marked as ${marker}`);
        },
      }
    );

    // Update field list with any restrictions found during sample fetch
    if (sampleResult.restrictedFields.length > 0) {
      currentFieldsToFetch = currentFieldsToFetch.filter(f => !restrictedFieldsMap.has(f));
      console.error(`[DataSync] Found ${sampleResult.restrictedFields.length} restricted fields during sample fetch`);
    }

    if (sampleResult.records.length === 0) {
      return {
        success: false,
        model_name: config.model_name,
        records_processed: 0,
        records_embedded: 0,
        records_failed: 0,
        duration_ms: Date.now() - startTime,
        errors: [`No records found for model: ${config.model_name}`],
        restricted_fields: [],
        warnings,
      };
    }

    // Validate schema-data alignment (with remaining fields)
    const odooFields = Object.keys(sampleResult.records[0]);
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
          ...validation.missing_in_schema.slice(0, 20),
          validation.missing_in_schema.length > 20
            ? `... and ${validation.missing_in_schema.length - 20} more`
            : '',
          '',
          'Please update schema first (sync schema), then retry data sync.',
        ].filter(Boolean),
        restricted_fields: [],
        warnings,
      };
    }

    console.error(`[DataSync] Schema validation passed: ${validation.matched_fields.length} fields matched`);

    // Build encoding context with restricted fields (Map: field → reason)
    const encodingContext: EncodingContext = {
      model_name: config.model_name,
      restricted_fields: restrictedFieldsMap,
    };

    // Ensure indexes exist for data points
    await ensureDataIndexes();

    // Phase 3: STREAMING - Fetch, encode, embed, upsert in batches
    // This avoids loading all records into memory at once
    const fetchBatchSize = DATA_TRANSFORM_CONFIG.FETCH_BATCH_SIZE;
    const embedBatchSize = DATA_TRANSFORM_CONFIG.EMBED_BATCH_SIZE;

    // Get total count
    const totalRecords = config.test_limit
      ? Math.min(config.test_limit, await client.searchCount(config.model_name, domain, context))
      : await client.searchCount(config.model_name, domain, context);

    console.error(`[DataSync] Starting streaming sync of ${totalRecords} records`);
    if (restrictedFieldsMap.size > 0) {
      console.error(`[DataSync] Excluding ${restrictedFieldsMap.size} restricted fields from fetch`);
    }
    onProgress?.('streaming', 0, totalRecords);

    let offset = 0;
    let totalProcessed = 0;
    let totalEmbedded = 0;
    const maxRecords = config.test_limit || totalRecords;

    while (offset < maxRecords) {
      const limit = Math.min(fetchBatchSize, maxRecords - offset);

      // Step 1: Fetch batch from Odoo with resilient handling
      const batchResult = await client.searchReadWithRetry<Record<string, unknown>>(
        config.model_name,
        domain,
        currentFieldsToFetch,
        { limit, offset, order: 'id', context },
        {
          maxRetries: 5,
          onFieldRestricted: (field, reason) => {
            // New restriction found during batch - add to tracking
            if (!restrictedFieldsMap.has(field)) {
              restrictedFieldsMap.set(field, reason);
              const marker = reason === 'odoo_error' ? 'Restricted_odoo_error' : 'Restricted_from_API';
              warnings.push(`Field '${field}' restricted (${reason}) - discovered during batch at offset ${offset}, marked as ${marker}`);
              console.error(`[DataSync] New restricted field discovered: ${field} (${reason})`);
            }
          },
        }
      );

      // Update field list if new restrictions found
      if (batchResult.restrictedFields.length > 0) {
        currentFieldsToFetch = currentFieldsToFetch.filter(f => !restrictedFieldsMap.has(f));
        // Encoding context already references the Map, so it's updated automatically
      }

      const batch = batchResult.records;
      if (batch.length === 0) break;

      totalProcessed += batch.length;
      const fetchPct = Math.round((totalProcessed / totalRecords) * 100);
      console.error(`[DataSync] Fetched batch: ${totalProcessed}/${totalRecords} records (${fetchPct}%)`);

      // Step 2: Encode batch with restricted field markers
      const encodedBatch = transformRecords(batch, encodingMap, config, encodingContext);

      // Step 3: Embed and upsert in smaller chunks
      for (let i = 0; i < encodedBatch.length; i += embedBatchSize) {
        const embedChunk = encodedBatch.slice(i, i + embedBatchSize);

        try {
          // Generate embeddings
          const texts = embedChunk.map(r => r.encoded_string);
          const embeddings = await embedBatch(texts, 'document');

          // Build data points
          const points: DataPoint[] = embedChunk.map((record, idx) => ({
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
          totalEmbedded += embedChunk.length;

          const embedPct = Math.round((totalEmbedded / totalRecords) * 100);
          console.error(`[DataSync] Embedded: ${totalEmbedded}/${totalRecords} records (${embedPct}%)`);

          onProgress?.('embedding', totalEmbedded, totalRecords);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          errors.push(`Embed batch at offset ${offset + i} failed: ${errMsg}`);
          console.error(`[DataSync] Embed error:`, errMsg);
        }
      }

      offset += batch.length;

      // Break if we got fewer records than requested
      if (batch.length < limit) break;
    }

    onProgress?.('complete', totalEmbedded, totalRecords);
    console.error(`[DataSync] Complete: ${totalEmbedded}/${totalProcessed} records embedded`);

    if (restrictedFieldsMap.size > 0) {
      console.error(`[DataSync] Restricted fields (${restrictedFieldsMap.size}): ${Array.from(restrictedFieldsMap.keys()).join(', ')}`);
    }

    // Build restricted fields array for result
    const restrictedFieldsResult: FieldRestriction[] = Array.from(restrictedFieldsMap.entries()).map(
      ([field_name, reason]) => ({
        field_name,
        reason,
        detected_at: new Date().toISOString(),
      })
    );

    return {
      success: errors.length === 0,
      model_name: config.model_name,
      records_processed: totalProcessed,
      records_embedded: totalEmbedded,
      records_failed: totalProcessed - totalEmbedded,
      duration_ms: Date.now() - startTime,
      errors: errors.length > 0 ? errors : undefined,
      restricted_fields: restrictedFieldsResult,
      warnings,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    // Build restricted fields array even on error
    const restrictedFieldsResult: FieldRestriction[] = Array.from(restrictedFieldsMap.entries()).map(
      ([field_name, reason]) => ({
        field_name,
        reason,
        detected_at: new Date().toISOString(),
      })
    );

    return {
      success: false,
      model_name: config.model_name,
      records_processed: 0,
      records_embedded: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
      errors: [errMsg],
      restricted_fields: restrictedFieldsResult,
      warnings,
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
