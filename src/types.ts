/**
 * TypeScript type definitions for odoo-vector-mcp
 *
 * Updated for numeric table-prefixed encoding system:
 * Format: {TABLE_NUMBER}^{COLUMN_NUMBER}*{VALUE}
 */

// =============================================================================
// ODOO TYPES
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
 * CRM Lead (Opportunity) from Odoo
 *
 * Includes all fields from 10 tables:
 * - Table 1: crm.lead (core opportunity data)
 * - Tables 2-10: Related entities via foreign keys
 */
export interface CrmLead {
  // Table 1 - Core fields
  id: number;
  name: string;
  expected_revenue?: number;
  probability?: number;
  description?: string | false;
  create_date: string;
  write_date?: string;
  date_closed?: string | false;
  city?: string | false;
  active?: boolean;
  is_won?: boolean;

  // Standard relation fields (many2one)
  partner_id?: OdooRelation;        // Table 2: res.partner (Contact)
  stage_id?: OdooRelation;          // Table 3: crm.stage (Stage)
  user_id?: OdooRelation;           // Table 4: res.users (User)
  team_id?: OdooRelation;           // Table 5: crm.team (Team)
  state_id?: OdooRelation;          // Table 6: res.country.state (State)
  lost_reason_id?: OdooRelation;    // Table 7: crm.lost.reason (Lost Reason)

  // Custom relation fields (many2one)
  x_specification_id?: OdooRelation; // Table 8: x_specification (Specification)
  x_lead_source_id?: OdooRelation;   // Table 9: x_lead_source (Lead Source)
  x_architect_id?: OdooRelation;     // Table 10: res.partner (Architect)
}

/**
 * CRM Stage from Odoo
 */
export interface CrmStage {
  id: number;
  name: string;
  is_won?: boolean;
  sequence?: number;
}

// =============================================================================
// SCHEMA TYPES
// =============================================================================

/**
 * Schema vector stored in crm_schema collection
 *
 * Uses numeric code format: {TABLE_NUMBER}^{COLUMN_NUMBER}
 * Example: "1^10" for crm.lead.expected_revenue
 */
export interface SchemaVector {
  id: string;              // Schema code: "1^1", "2^10", etc.
  table_number: number;    // Table identifier: 1, 2, 3...
  column_number: number;   // Column identifier: 1, 10, 20...
  table: string;           // Odoo table: "crm.lead"
  field: string;           // Odoo field: "name"
  type: string;            // Data type: "char", "integer", etc.
  semantic: string;        // Human-readable description
}

/**
 * Schema search result with similarity score
 */
export interface SchemaSearchResult {
  code: string;            // "1^10"
  table_number: number;    // 1
  column_number: number;   // 10
  table: string;
  field: string;
  type: string;
  semantic: string;
  score: number;           // Similarity score (0-1)
}

// =============================================================================
// ENCODING TYPES
// =============================================================================

/**
 * Single decoded field from an encoded string
 *
 * Example: From "1^10*450000", produces:
 * {
 *   code: "1^10",
 *   table_number: 1,
 *   column_number: 10,
 *   value: "450000",
 *   table: "crm.lead",
 *   field: "expected_revenue",
 *   type: "float",
 *   parsedValue: 450000
 * }
 */
export interface DecodedField {
  code: string;            // "1^10"
  table_number: number;    // 1
  column_number: number;   // 10
  value: string;           // Raw value from encoded string
  table: string;           // "crm.lead"
  field: string;           // "expected_revenue"
  type: string;            // "float"
  parsedValue: unknown;    // Type-converted value
}

/**
 * Fully decoded record with organization by table number
 *
 * Example _by_table structure:
 * {
 *   1: { name: "Hospital Project", expected_revenue: 450000, ... },
 *   2: { name: "Hansen Yuncken" },
 *   3: { name: "Tender RFQ" }
 * }
 */
export interface DecodedRecord {
  raw: string;             // Original encoded string
  fields: DecodedField[];  // All decoded fields
  _schema_codes: string[]; // List of schema codes found: ["1^1", "1^10", "2^1"]
  _by_table: Record<number, Record<string, unknown>>;  // Organized by table NUMBER
}

// =============================================================================
// VECTOR TYPES
// =============================================================================

/**
 * Payload stored with each opportunity vector in crm_data
 *
 * Contains indexed fields for efficient filtering plus encoded string
 */
export interface OpportunityPayload {
  odoo_id: number;
  entity_type: 'opportunity';
  encoded_string: string;
  semantic_text: string;

  // Core indexed fields for filtering
  stage_id?: number;
  user_id?: number;
  team_id?: number;
  expected_revenue?: number;
  probability?: number;
  is_won?: boolean;
  is_lost?: boolean;
  is_active?: boolean;
  city?: string;
  state_name?: string;
  create_date?: string;

  // New indexed fields (Tables 8-10)
  specification_id?: number;
  specification_name?: string;
  lead_source_id?: number;
  lead_source_name?: string;
  architect_id?: number;
  architect_name?: string;

  // Semantic fields for rich display
  opportunity_name?: string;
  contact_name?: string;
  stage_name?: string;
  user_name?: string;
  team_name?: string;
  lost_reason_name?: string;

  // Sync metadata
  sync_timestamp: string;
}

/**
 * Vector search result
 */
export interface VectorSearchResult {
  id: number;
  score: number;
  payload: OpportunityPayload;
}

/**
 * Vector query options
 */
export interface VectorQueryOptions {
  vector: number[];
  limit?: number;
  minScore?: number;
  filter?: VectorFilter;
}

/**
 * Vector filter for structured queries
 *
 * Supports filtering by indexed payload fields
 */
export interface VectorFilter {
  stage_id?: number | { $in: number[] };
  user_id?: number | { $in: number[] };
  team_id?: number;
  is_won?: boolean;
  is_lost?: boolean;
  is_active?: boolean;
  expected_revenue?: { $gte?: number; $lte?: number };
  create_date?: { $gte?: string; $lte?: string };

  // New filters for Tables 8-10
  specification_id?: number;
  lead_source_id?: number;
  architect_id?: number;
}

// =============================================================================
// SYNC TYPES
// =============================================================================

/**
 * Sync operation result
 */
export interface SyncResult {
  success: boolean;
  recordsSynced: number;
  recordsFailed: number;
  durationMs: number;
  errors?: string[];
}

/**
 * Sync progress callback
 */
export interface SyncProgress {
  phase: 'fetching' | 'encoding' | 'embedding' | 'upserting';
  current: number;
  total: number;
  message?: string;
}

/**
 * Sync status
 */
export interface SyncStatus {
  lastSync: string | null;
  totalRecords: number;
  isRunning: boolean;
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
