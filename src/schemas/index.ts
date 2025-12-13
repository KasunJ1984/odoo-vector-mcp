/**
 * Zod Validation Schemas
 *
 * Defines input validation for all MCP tools.
 */

import { z } from 'zod';

// =============================================================================
// SCHEMA DISCOVERY TOOL
// =============================================================================

/**
 * Schema for vector_discover_schema tool
 *
 * Search schema definitions by semantic meaning.
 * Example: { query: "fields about revenue", limit: 5 }
 */
export const DiscoverSchemaSchema = z.object({
  query: z.string()
    .min(3, 'Query must be at least 3 characters')
    .max(200, 'Query must be at most 200 characters')
    .describe('Semantic query to find schema fields. Examples: "fields about money", "contact information", "dates"'),

  limit: z.number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Number of schema matches to return (default: 5, max: 20)'),

  table_filter: z.string()
    .optional()
    .describe('Optional: filter to specific Odoo table like "crm.lead" or "res.partner"'),
}).strict();

export type DiscoverSchemaInput = z.infer<typeof DiscoverSchemaSchema>;

// =============================================================================
// SEMANTIC SEARCH TOOL
// =============================================================================

/**
 * Schema for vector_semantic_search tool
 *
 * Natural language search across opportunities.
 */
export const SemanticSearchSchema = z.object({
  query: z.string()
    .min(10, 'Query must be at least 10 characters')
    .max(500, 'Query must be at most 500 characters')
    .describe('Natural language search query. Examples: "hospital projects in Victoria", "lost deals over $100k"'),

  limit: z.number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Number of results to return (default: 10, max: 50)'),

  min_similarity: z.number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe('Minimum similarity score 0-1 (default: 0.6)'),

  // Optional filters
  stage_id: z.number().int().positive().optional()
    .describe('Filter by stage ID'),

  user_id: z.number().int().positive().optional()
    .describe('Filter by salesperson ID'),

  is_won: z.boolean().optional()
    .describe('Filter for won opportunities'),

  is_lost: z.boolean().optional()
    .describe('Filter for lost opportunities'),

  min_revenue: z.number().min(0).optional()
    .describe('Minimum expected revenue'),

  max_revenue: z.number().min(0).optional()
    .describe('Maximum expected revenue'),

  sector: z.string().optional()
    .describe('Filter by sector (Education, Healthcare, Commercial, etc.)'),
}).strict();

export type SemanticSearchInput = z.infer<typeof SemanticSearchSchema>;

// =============================================================================
// DECODE TOOL
// =============================================================================

/**
 * Schema for vector_decode tool
 *
 * Decode an encoded string to structured data.
 */
export const DecodeSchema = z.object({
  encoded_string: z.string()
    .min(1, 'Encoded string is required')
    .describe('The encoded string to decode, e.g., "O_1*Hospital Project|O_10*450000|C_1*Hansen Yuncken"'),

  include_raw: z.boolean()
    .default(false)
    .describe('Include the raw encoded string in output (default: false)'),
}).strict();

export type DecodeInput = z.infer<typeof DecodeSchema>;

// =============================================================================
// SYNC TOOL
// =============================================================================

/**
 * Schema for vector_sync tool
 *
 * Sync data from Odoo to vector database.
 */
export const SyncSchemaBase = z.object({
  action: z.enum(['status', 'full_sync', 'sync_record'])
    .describe('Sync action: "status" to check state, "full_sync" to rebuild index, "sync_record" for single record'),

  lead_id: z.number()
    .int()
    .positive()
    .optional()
    .describe('For sync_record action: the opportunity ID to sync'),
}).strict();

// Use base schema for MCP tool registration (it has .shape)
export const SyncSchema = SyncSchemaBase;

export type SyncInput = z.infer<typeof SyncSchemaBase>;

// =============================================================================
// EXPORT ALL SCHEMAS
// =============================================================================

export const schemas = {
  DiscoverSchemaSchema,
  SemanticSearchSchema,
  DecodeSchema,
  SyncSchema,
};
