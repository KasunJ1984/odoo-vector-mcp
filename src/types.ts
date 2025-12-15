/**
 * TypeScript type definitions for odoo-vector-mcp
 *
 * Redesigned for comprehensive Odoo schema search using 4^XX* encoding format.
 * Phase 1: Schema semantic search
 * Phase 2: Will add data extraction using Odoo client
 */

// =============================================================================
// ODOO TYPES (KEPT FOR PHASE 2)
// =============================================================================

/**
 * Odoo connection configuration
 */
export interface OdooConfig {
  url: string;
  db: string;
  username: string;
  password: string;
}

/**
 * Odoo relation field tuple [id, name] or false if not set
 */
export type OdooRelation = [number, string] | false;

/**
 * Type guard to check if an Odoo relation is valid (not false)
 */
export function isValidRelation(relation: OdooRelation | undefined): relation is [number, string] {
  return Array.isArray(relation) && relation.length === 2;
}

/**
 * Safely get relation name
 */
export function getRelationName(relation: OdooRelation | undefined): string {
  return isValidRelation(relation) ? relation[1] : '';
}

/**
 * Safely get relation ID
 */
export function getRelationId(relation: OdooRelation | undefined): number | undefined {
  return isValidRelation(relation) ? relation[0] : undefined;
}

/**
 * CRM Lead record from Odoo (KEPT FOR PHASE 2)
 *
 * This type represents a crm.lead record with all its relational fields.
 * Used by odoo-client.ts for fetching lead data.
 */
export interface CrmLead {
  id: number;
  name: string | false;
  expected_revenue: number;
  probability: number;
  description: string | false;
  create_date: string | false;
  write_date: string | false;
  date_closed: string | false;
  city: string | false;
  active: boolean;

  // Standard FK relations (return [id, name] or false)
  partner_id: OdooRelation;
  stage_id: OdooRelation;
  user_id: OdooRelation;
  team_id: OdooRelation;
  state_id: OdooRelation;
  lost_reason_id: OdooRelation;

  // Custom FK relations
  x_specification_id: OdooRelation;
  x_lead_source_id: OdooRelation;
  x_architect_id: OdooRelation;
}

// =============================================================================
// ODOO SCHEMA TYPES (NEW - 4^XX* FORMAT)
// =============================================================================

/**
 * Parsed Odoo schema row from the 4^XX* encoded format
 *
 * Each row describes one field from ir.model.fields with relationship tracing.
 *
 * Source format:
 * 4^58*[Model_ID]|4^58*[Field_ID]|4^26*[Field_Name]|4^33*[Field_Label]|
 * 4^35*[Field_Type]|4^28*[Model_Name]|4^60000*[Primary_Location]|
 * 4^57*[Stored]|4^60001*[PrimaryModelID^PrimaryFieldID]*
 *
 * Example:
 * 4^58*292|4^58*28105|4^26*account_type|4^33*Type|4^35*selection|
 * 4^28*account.account|4^60000*account.account.account_type|4^57*Yes|4^60001*292^28105*
 */
export interface OdooSchemaRow {
  // IDs from ir.model and ir.model.fields
  model_id: number;           // 4^58* - Model ID in ir.model
  field_id: number;           // 4^58* - Field ID in ir.model.fields

  // Field metadata
  field_name: string;         // 4^26* - Technical name (e.g., "user_id")
  field_label: string;        // 4^33* - Display label (e.g., "Salesperson")
  field_type: string;         // 4^35* - Type (char, many2one, one2many, etc.)
  model_name: string;         // 4^28* - Model name (e.g., "crm.lead")

  // Primary data location (WHERE the data actually lives)
  primary_data_location: string;  // 4^60000* - Location (e.g., "res.users.id")
  stored: boolean;                // 4^57* - Is field stored in database?

  // Primary data reference IDs
  primary_model_id: number | string;  // 4^60001* before ^ - Model ID where data lives
  primary_field_id: number | string;  // 4^60001* after ^ - Field ID where data lives

  // Original encoded string for display
  raw_encoded: string;
}

/**
 * Schema search result with similarity score
 */
export interface SchemaSearchResult {
  score: number;              // Similarity score (0-1)
  schema: OdooSchemaRow;      // The matched schema row
}

/**
 * Filter for schema search
 *
 * Supports multiple search modes:
 * - semantic: Vector similarity search with optional filters
 * - list: Get all fields in a model (filter only)
 * - references_out: Find relational fields in a model
 * - references_in: Find fields that reference a model
 */
export interface SchemaFilter {
  model_name?: string;                    // Filter by model (e.g., "crm.lead")
  field_type?: string | string[];         // Filter by type(s) (e.g., "many2one" or ["many2one", "one2many"])
  stored_only?: boolean;                  // Only stored fields
  primary_data_location_prefix?: string;  // Filter by primary_data_location prefix (for references_in)
}

/**
 * Schema payload stored in Qdrant vector
 */
export interface SchemaPayload {
  // Core identifiers
  model_id: number;
  field_id: number;
  model_name: string;
  field_name: string;
  field_label: string;
  field_type: string;

  // Data location
  primary_data_location: string;
  primary_model_id: string;
  primary_field_id: string;
  stored: boolean;

  // The semantic text that was embedded
  semantic_text: string;

  // Original encoded string
  raw_encoded: string;

  // Sync metadata
  sync_timestamp: string;
}

// =============================================================================
// VECTOR TYPES
// =============================================================================

/**
 * Schema point for upserting to Qdrant
 */
export interface SchemaPoint {
  id: number;                 // Using field_id as unique identifier
  vector: number[];           // Embedding vector
  payload: SchemaPayload;     // Metadata
}

/**
 * Vector search result from Qdrant
 */
export interface VectorSearchResult {
  id: number;
  score: number;
  payload: SchemaPayload;
}

// =============================================================================
// SYNC TYPES
// =============================================================================

/**
 * Schema sync result
 */
export interface SchemaSyncResult {
  success: boolean;
  uploaded: number;
  failed: number;
  durationMs: number;
  errors?: string[];
}

/**
 * Schema sync status
 */
export interface SchemaSyncStatus {
  collection: string;
  vectorCount: number;
  lastSync: string | null;
}

// =============================================================================
// MCP TOOL TYPES
// =============================================================================

/**
 * Tool response content
 */
export interface ToolContent {
  type: 'text';
  text: string;
}

/**
 * Tool result
 */
export interface ToolResult {
  content: ToolContent[];
}

// =============================================================================
// INCREMENTAL SYNC TYPES
// =============================================================================

/**
 * Result of incremental sync operation
 */
export interface IncrementalSyncResult {
  /** Whether sync completed successfully */
  success: boolean;
  /** Number of new fields added */
  added: number;
  /** Number of modified fields updated */
  modified: number;
  /** Number of deleted fields removed */
  deleted: number;
  /** Number of unchanged fields skipped */
  unchanged: number;
  /** Total sync duration in milliseconds */
  durationMs: number;
  /** Whether cache was cleared (only if changes occurred) */
  cacheCleared: boolean;
  /** Error messages if any */
  errors?: string[];
}
