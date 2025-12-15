/**
 * Zod validation schemas for MCP tools
 *
 * Redesigned for comprehensive Odoo schema search.
 * Phase 1: ONE tool - semantic_search for schema discovery
 */

import { z } from 'zod';

// =============================================================================
// SEMANTIC SEARCH SCHEMA
// =============================================================================

/**
 * Schema for semantic_search tool input
 *
 * Searches Odoo schema (17,930 fields) semantically to find:
 * - Where data is stored
 * - Field relationships
 * - Data types and locations
 */
export const SemanticSearchSchema = z.object({
  /**
   * Natural language query to search for fields
   * Examples:
   * - "Where is customer email stored?"
   * - "Fields related to revenue"
   * - "crm.lead date fields"
   * - "How is salesperson connected to leads?"
   */
  query: z
    .string()
    .min(1, 'Query must be at least 1 character')
    .max(500, 'Query must be at most 500 characters')
    .describe('Natural language query to search Odoo schema'),

  /**
   * Search mode determines how the query is processed:
   * - semantic: Natural language vector search (default)
   * - list: Get ALL fields in a model (filter-only, no vector similarity)
   * - references_out: Find fields that POINT TO a model (outgoing FKs)
   * - references_in: Find fields that are POINTED AT by other models (incoming FKs)
   */
  search_mode: z
    .enum(['semantic', 'list', 'references_out', 'references_in'])
    .default('semantic')
    .describe('Search mode: semantic=vector search, list=all fields in model, references_out=outgoing FKs, references_in=incoming FKs'),

  /**
   * Maximum number of results to return
   */
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(10)
    .describe('Maximum number of results (1-200, default: 10)'),

  /**
   * Minimum similarity score (0-1) - only used in semantic mode
   */
  min_similarity: z
    .number()
    .min(0)
    .max(1)
    .default(0.35)
    .describe('Minimum similarity score for semantic mode (0-1, default: 0.35)'),

  /**
   * Filter by model name (e.g., "crm.lead")
   * Required for list, references_out, and references_in modes
   */
  model_filter: z
    .string()
    .optional()
    .describe('Filter results to specific model (e.g., "crm.lead"). Required for list/references modes.'),

  /**
   * Filter by field type (e.g., "many2one", "char")
   */
  type_filter: z
    .string()
    .optional()
    .describe('Filter results to specific field type (e.g., "many2one")'),

  /**
   * Only show stored fields (exclude computed)
   */
  stored_only: z
    .boolean()
    .default(false)
    .describe('Only show stored fields, exclude computed fields'),

  /**
   * Filter by point type: schema, data, or all
   * - schema: Search field definitions (default)
   * - data: Search actual CRM records
   * - all: Search both schema and data together
   */
  point_type: z
    .enum(['schema', 'data', 'all'])
    .default('schema')
    .describe('Point type: schema=field definitions, data=CRM records, all=both'),
}).strict();

/**
 * Inferred type from schema
 */
export type SemanticSearchInput = z.infer<typeof SemanticSearchSchema>;

// =============================================================================
// SYNC SCHEMA (for initial data upload)
// =============================================================================

/**
 * Schema for sync action input
 */
export const SyncSchema = z.object({
  /**
   * Sync action to perform
   *
   * - status: Check sync status and collection info
   * - full_sync: Upload ALL schema fields (17,930) - slow but complete
   * - incremental_sync: Only sync changed fields - fast, preserves cache if no changes
   */
  action: z
    .enum(['status', 'full_sync', 'incremental_sync'])
    .describe('Action: "status" = check status, "full_sync" = upload all, "incremental_sync" = only changed fields'),

  /**
   * Force recreate collection (deletes existing data)
   * Only applies to full_sync action
   */
  force_recreate: z
    .boolean()
    .default(false)
    .describe('Delete and recreate collection before sync (full_sync only)'),
}).strict();

/**
 * Inferred type from schema
 */
export type SyncInput = z.infer<typeof SyncSchema>;

// =============================================================================
// TRANSFORM DATA SCHEMA (Phase 2 - Data Encoding)
// =============================================================================

/**
 * Schema for transform_data tool input
 *
 * Transforms ANY Odoo model data into coordinate-encoded format for embedding.
 * Now supports DYNAMIC model discovery - provide any model name and the tool
 * automatically discovers fields from the schema.
 *
 * Trigger format: "transfer_[model.name]_1984" to prevent accidental syncs.
 * Examples:
 * - "transfer_crm.lead_1984"
 * - "transfer_res.partner_1984"
 * - "transfer_sale.order_1984"
 */
export const TransformDataSchema = z.object({
  /**
   * Trigger command - must match pattern to prevent accidents
   *
   * Format: "transfer_[model.name]_1984"
   * - "transfer_" = action prefix
   * - "[model.name]" = any valid Odoo model name (e.g., crm.lead, res.partner)
   * - "_1984" = confirmation code
   *
   * Examples:
   * - "transfer_crm.lead_1984"
   * - "transfer_res.partner_1984"
   * - "transfer_product.product_1984"
   *
   * The tool extracts the model name and validates it exists in the schema.
   */
  command: z
    .string()
    .regex(
      /^transfer_[a-z_]+(\.[a-z_]+)*_1984$/,
      'Command must be "transfer_[model.name]_1984" (e.g., transfer_crm.lead_1984, transfer_res.partner_1984)'
    )
    .describe('Trigger command: "transfer_[model.name]_1984" - extracts model name dynamically'),

  /**
   * Include archived records (active=false)
   * Default: true - sync ALL records including archived
   */
  include_archived: z
    .boolean()
    .default(true)
    .describe('Include archived records (active=false). Default: true'),

  /**
   * TESTING ONLY: Limit records for debugging
   * Omit this parameter for full table sync
   */
  test_limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('TESTING ONLY: Limit records for debugging. Omit for full table sync.'),
}).strict();

/**
 * Inferred type from schema
 */
export type TransformDataInput = z.infer<typeof TransformDataSchema>;

/**
 * Schema for preview encoding map (no sync)
 */
export const PreviewEncodingSchema = z.object({
  /**
   * Model name to preview encoding map for
   */
  model_name: z
    .string()
    .min(1)
    .describe('Model name to preview encoding map for (e.g., "crm.lead")'),
}).strict();

/**
 * Inferred type from schema
 */
export type PreviewEncodingInput = z.infer<typeof PreviewEncodingSchema>;

// =============================================================================
// SEARCH DATA SCHEMA (Phase 2 - Data Search)
// =============================================================================

/**
 * Schema for search_data tool input
 *
 * Searches synced Odoo data records semantically.
 */
export const SearchDataSchema = z.object({
  /**
   * Natural language query to search data
   * Examples:
   * - "Hospital projects in Victoria"
   * - "High value opportunities over 500000"
   * - "Leads from Hansen Yuncken"
   */
  query: z
    .string()
    .min(1, 'Query must be at least 1 character')
    .max(500, 'Query must be at most 500 characters')
    .describe('Natural language query to search CRM data'),

  /**
   * Maximum number of results to return
   */
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('Maximum number of results (1-100, default: 10)'),

  /**
   * Minimum similarity score (0-1)
   */
  min_similarity: z
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe('Minimum similarity score (0-1, default: 0.3)'),
}).strict();

/**
 * Inferred type from schema
 */
export type SearchDataInput = z.infer<typeof SearchDataSchema>;

// =============================================================================
// EXPORT ALL SCHEMAS
// =============================================================================

export const schemas = {
  SemanticSearchSchema,
  SyncSchema,
  TransformDataSchema,
  PreviewEncodingSchema,
  SearchDataSchema,
};
