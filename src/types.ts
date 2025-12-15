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
  point_type?: 'schema' | 'data' | 'all'; // Filter by point type (schema, data, or all)
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

  // Type discriminator (added for unified search)
  point_type?: 'schema';
}

/**
 * Union type for any payload in the collection
 */
export type AnyPayload = SchemaPayload | DataPayload;

/**
 * Type guard to check if payload is DataPayload
 */
export function isDataPayload(payload: AnyPayload): payload is DataPayload {
  return (payload as DataPayload).point_type === 'data';
}

/**
 * Type guard to check if payload is SchemaPayload
 */
export function isSchemaPayload(payload: AnyPayload): payload is SchemaPayload {
  return !isDataPayload(payload);
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
 * Vector search result from Qdrant (supports both schema and data)
 */
export interface VectorSearchResult {
  id: number;
  score: number;
  payload: AnyPayload;
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

// =============================================================================
// DATA TRANSFORMER TYPES (Phase 2 - Data Encoding)
// =============================================================================

/**
 * Field encoding map: field_name → encoding prefix
 *
 * The prefix format is: [model_id]^[field_id]
 * - For native fields: model's own prefix (e.g., "344^6299" for expected_revenue)
 * - For FK fields: TARGET model's id prefix (e.g., "78^956" for partner_id → res.partner)
 */
export interface FieldEncodingMap {
  [field_name: string]: {
    /** Encoding prefix: model_id^field_id (e.g., "344^6299" or "78^956") */
    prefix: string;
    /** Field type from schema (char, many2one, boolean, etc.) */
    field_type: string;
    /** True if many2one/many2many field */
    is_foreign_key: boolean;
    /** For FK fields: target model name (e.g., "res.partner") */
    target_model?: string;
  };
}

/**
 * Encoded record ready for embedding
 */
export interface EncodedRecord {
  /** Odoo record ID */
  record_id: number;
  /** Source model name (e.g., "crm.lead") */
  model_name: string;
  /** Model ID for point ID generation */
  model_id: number;
  /** The full encoded string: 344^6327*1|344^6299*50000|... */
  encoded_string: string;
  /** Number of fields in the encoded string */
  field_count: number;
}

/**
 * Data payload stored in Qdrant vector
 * Distinguished from SchemaPayload by point_type: 'data'
 */
export interface DataPayload {
  /** Odoo record ID */
  record_id: number;
  /** Source model name */
  model_name: string;
  /** Model ID */
  model_id: number;
  /** The encoded string */
  encoded_string: string;
  /** Number of fields encoded */
  field_count: number;
  /** When this record was synced */
  sync_timestamp: string;
  /** Type discriminator to distinguish from schema */
  point_type: 'data';
}

/**
 * Data point for upserting to Qdrant
 */
export interface DataPoint {
  /** Unique ID: model_id * 10_000_000 + record_id */
  id: number;
  /** Embedding vector */
  vector: number[];
  /** Data payload */
  payload: DataPayload;
}

/**
 * Result of data sync operation
 */
export interface DataSyncResult {
  /** Whether sync completed successfully */
  success: boolean;
  /** Model name that was synced */
  model_name: string;
  /** Total records processed from Odoo */
  records_processed: number;
  /** Records successfully embedded and uploaded */
  records_embedded: number;
  /** Records that failed to process */
  records_failed: number;
  /** Total duration in milliseconds */
  duration_ms: number;
  /** Error messages if any */
  errors?: string[];
}

/**
 * Schema-Data validation result
 *
 * Ensures every Odoo field has a corresponding schema entry.
 * Sync will FAIL if any field is missing from schema.
 */
export interface ValidationResult {
  /** True if all Odoo fields have schema entries */
  valid: boolean;
  /** Fields that matched between Odoo and schema */
  matched_fields: string[];
  /** Odoo fields NOT in schema - CAUSES FAILURE */
  missing_in_schema: string[];
  /** Schema fields not in Odoo - informational only */
  missing_in_odoo: string[];
}

/**
 * Configuration for data transform operation
 */
export interface DataTransformConfig {
  /** Model name (e.g., "crm.lead") */
  model_name: string;
  /** Model ID (e.g., 344 for crm.lead) */
  model_id: number;
  /** Field ID for the 'id' column (e.g., 6327 for crm.lead.id) */
  id_field_id: number;
  /** Include archived records (active=false). Default: true */
  include_archived?: boolean;
  /** Testing only: limit records for debugging */
  test_limit?: number;
}
