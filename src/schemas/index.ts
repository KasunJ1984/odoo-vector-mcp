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
    .default(0.5)
    .describe('Minimum similarity score for semantic mode (0-1, default: 0.5)'),

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
   */
  action: z
    .enum(['status', 'full_sync'])
    .describe('Action: "status" to check sync status, "full_sync" to upload all schema'),

  /**
   * Force recreate collection (deletes existing data)
   */
  force_recreate: z
    .boolean()
    .default(false)
    .describe('Delete and recreate collection before sync'),
}).strict();

/**
 * Inferred type from schema
 */
export type SyncInput = z.infer<typeof SyncSchema>;

// =============================================================================
// EXPORT ALL SCHEMAS
// =============================================================================

export const schemas = {
  SemanticSearchSchema,
  SyncSchema,
};
