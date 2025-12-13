/**
 * TypeScript type definitions for odoo-vector-mcp
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
 */
export interface CrmLead {
  id: number;
  name: string;
  expected_revenue?: number;
  probability?: number;
  description?: string | false;
  create_date: string;
  write_date?: string;
  date_closed?: string | false;
  city?: string | false;
  x_sector?: string | false;
  active?: boolean;

  // Relation fields (many2one)
  partner_id?: OdooRelation;
  stage_id?: OdooRelation;
  user_id?: OdooRelation;
  team_id?: OdooRelation;
  state_id?: OdooRelation;
  lost_reason_id?: OdooRelation;
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
 */
export interface SchemaVector {
  id: string;              // Schema code: "O_1", "C_2", etc.
  code: string;            // Same as id
  table: string;           // Odoo table: "crm.lead"
  field: string;           // Odoo field: "name"
  type: string;            // Data type: "char", "integer", etc.
  semantic: string;        // Human-readable description
}

/**
 * Schema search result with similarity score
 */
export interface SchemaSearchResult {
  code: string;
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
 */
export interface DecodedField {
  code: string;            // "O_1"
  value: string;           // Raw value from encoded string
  table: string;           // "crm.lead"
  field: string;           // "name"
  type: string;            // "char"
  parsedValue: unknown;    // Type-converted value
}

/**
 * Fully decoded record with organization by table
 */
export interface DecodedRecord {
  raw: string;             // Original encoded string
  fields: DecodedField[];  // All decoded fields
  _by_table: Record<string, Record<string, unknown>>;  // Organized by table
}

// =============================================================================
// VECTOR TYPES
// =============================================================================

/**
 * Payload stored with each opportunity vector in crm_data
 */
export interface OpportunityPayload {
  odoo_id: number;
  entity_type: 'opportunity';
  encoded_string: string;
  semantic_text: string;

  // Indexed fields for filtering
  stage_id?: number;
  user_id?: number;
  team_id?: number;
  expected_revenue?: number;
  probability?: number;
  is_won?: boolean;
  is_lost?: boolean;
  is_active?: boolean;
  sector?: string;
  city?: string;
  state_name?: string;
  create_date?: string;

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
 */
export interface VectorFilter {
  stage_id?: number | { $in: number[] };
  user_id?: number | { $in: number[] };
  team_id?: number;
  is_won?: boolean;
  is_lost?: boolean;
  is_active?: boolean;
  sector?: string;
  expected_revenue?: { $gte?: number; $lte?: number };
  create_date?: { $gte?: string; $lte?: string };
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
