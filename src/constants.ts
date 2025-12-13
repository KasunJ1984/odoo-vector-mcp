/**
 * Constants for odoo-vector-mcp
 *
 * This file defines the source-table-prefixed encoding system.
 * Each prefix indicates which Odoo table the field comes from,
 * providing clear data lineage in the encoded strings.
 */

// =============================================================================
// ENVIRONMENT CONFIGURATION
// =============================================================================

export const ODOO_CONFIG = {
  URL: process.env.ODOO_URL || '',
  DB: process.env.ODOO_DB || '',
  USERNAME: process.env.ODOO_USERNAME || '',
  PASSWORD: process.env.ODOO_PASSWORD || '',
} as const;

export const QDRANT_CONFIG = {
  HOST: process.env.QDRANT_HOST || 'http://localhost:6333',
  API_KEY: process.env.QDRANT_API_KEY || '',
  SCHEMA_COLLECTION: process.env.SCHEMA_COLLECTION_NAME || 'crm_schema',
  DATA_COLLECTION: process.env.DATA_COLLECTION_NAME || 'crm_data',
  VECTOR_SIZE: 512,
  DISTANCE_METRIC: 'Cosine' as const,
} as const;

export const VOYAGE_CONFIG = {
  API_KEY: process.env.VOYAGE_API_KEY || '',
  MODEL: process.env.EMBEDDING_MODEL || 'voyage-3-lite',
  DIMENSIONS: 512,
  MAX_BATCH_SIZE: 128,
  INPUT_TYPE_DOCUMENT: 'document' as const,
  INPUT_TYPE_QUERY: 'query' as const,
} as const;

// =============================================================================
// SOURCE TABLE PREFIXES
// =============================================================================

/**
 * TABLE PREFIXES - The core of the self-describing architecture
 *
 * Each prefix identifies which Odoo table the field comes from:
 * - O_  = crm.lead (Opportunity)
 * - C_  = res.partner (Contact/Company)
 * - S_  = crm.stage (Pipeline Stage)
 * - U_  = res.users (User/Salesperson)
 * - T_  = crm.team (Sales Team)
 * - ST_ = res.country.state (State/Territory)
 * - LR_ = crm.lost.reason (Lost Reason)
 */
export const TABLE_PREFIXES = {
  O: 'crm.lead',
  C: 'res.partner',
  S: 'crm.stage',
  U: 'res.users',
  T: 'crm.team',
  ST: 'res.country.state',
  LR: 'crm.lost.reason',
} as const;

export type TablePrefix = keyof typeof TABLE_PREFIXES;

// =============================================================================
// SCHEMA DEFINITIONS (MVP: 23 fields)
// =============================================================================

/**
 * Each schema definition maps a code to its source and semantic meaning.
 *
 * Naming Convention:
 * - {PREFIX}_{SEQUENCE}
 * - Sequence ranges:
 *   - 1-9:   Primary identifiers (name, id)
 *   - 10-19: Numeric/financial fields
 *   - 20-29: Text/description fields
 *   - 30-39: Date/time fields
 *   - 40-49: Location/classification fields
 */
export interface SchemaDefinition {
  code: string;           // e.g., "O_1"
  table: string;          // e.g., "crm.lead"
  field: string;          // e.g., "name"
  type: 'char' | 'integer' | 'float' | 'text' | 'datetime' | 'date' | 'boolean' | 'selection';
  semantic: string;       // Human-readable description for embedding
  required: boolean;      // Is this field required?
  searchable: boolean;    // Should this be included in semantic text?
}

export const SCHEMA_DEFINITIONS: Record<string, SchemaDefinition> = {
  // ═══════════════════════════════════════════════════════════════════════════
  // O_ (crm.lead - Opportunity) - 10 fields
  // ═══════════════════════════════════════════════════════════════════════════

  O_1: {
    code: 'O_1',
    table: 'crm.lead',
    field: 'name',
    type: 'char',
    semantic: 'Opportunity name or project title - describes the deal being pursued',
    required: true,
    searchable: true,
  },
  O_2: {
    code: 'O_2',
    table: 'crm.lead',
    field: 'id',
    type: 'integer',
    semantic: 'Unique opportunity identifier in Odoo CRM system',
    required: true,
    searchable: false,
  },
  O_10: {
    code: 'O_10',
    table: 'crm.lead',
    field: 'expected_revenue',
    type: 'float',
    semantic: 'Expected revenue or deal value in dollars - the potential income from this opportunity',
    required: false,
    searchable: true,
  },
  O_11: {
    code: 'O_11',
    table: 'crm.lead',
    field: 'probability',
    type: 'integer',
    semantic: 'Win probability percentage from 0 to 100 - likelihood of closing the deal',
    required: false,
    searchable: true,
  },
  O_20: {
    code: 'O_20',
    table: 'crm.lead',
    field: 'description',
    type: 'text',
    semantic: 'Detailed description, notes, and context about the opportunity',
    required: false,
    searchable: true,
  },
  O_30: {
    code: 'O_30',
    table: 'crm.lead',
    field: 'create_date',
    type: 'datetime',
    semantic: 'Date and time when the opportunity was created in the system',
    required: true,
    searchable: false,
  },
  O_31: {
    code: 'O_31',
    table: 'crm.lead',
    field: 'write_date',
    type: 'datetime',
    semantic: 'Date and time when the opportunity was last modified',
    required: false,
    searchable: false,
  },
  O_32: {
    code: 'O_32',
    table: 'crm.lead',
    field: 'date_closed',
    type: 'date',
    semantic: 'Date when the opportunity was won or lost - the closing date',
    required: false,
    searchable: false,
  },
  O_40: {
    code: 'O_40',
    table: 'crm.lead',
    field: 'city',
    type: 'char',
    semantic: 'City where the project or opportunity is located',
    required: false,
    searchable: true,
  },
  O_41: {
    code: 'O_41',
    table: 'crm.lead',
    field: 'x_sector',
    type: 'selection',
    semantic: 'Industry sector classification - Education, Healthcare, Commercial, Residential, Government',
    required: false,
    searchable: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // C_ (res.partner - Contact/Company) - 4 fields
  // ═══════════════════════════════════════════════════════════════════════════

  C_1: {
    code: 'C_1',
    table: 'res.partner',
    field: 'name',
    type: 'char',
    semantic: 'Contact or company name - the business entity associated with the opportunity',
    required: true,
    searchable: true,
  },
  C_2: {
    code: 'C_2',
    table: 'res.partner',
    field: 'id',
    type: 'integer',
    semantic: 'Partner ID - unique identifier for the contact or company in Odoo',
    required: true,
    searchable: false,
  },
  C_10: {
    code: 'C_10',
    table: 'res.partner',
    field: 'email',
    type: 'char',
    semantic: 'Contact email address for communication',
    required: false,
    searchable: true,
  },
  C_11: {
    code: 'C_11',
    table: 'res.partner',
    field: 'phone',
    type: 'char',
    semantic: 'Contact phone number for communication',
    required: false,
    searchable: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // S_ (crm.stage - Pipeline Stage) - 2 fields
  // ═══════════════════════════════════════════════════════════════════════════

  S_1: {
    code: 'S_1',
    table: 'crm.stage',
    field: 'name',
    type: 'char',
    semantic: 'Pipeline stage name - where the opportunity is in the sales process (New, Qualification, Proposal, Negotiation, Won, Lost)',
    required: true,
    searchable: true,
  },
  S_2: {
    code: 'S_2',
    table: 'crm.stage',
    field: 'id',
    type: 'integer',
    semantic: 'Stage ID - unique identifier for the pipeline stage',
    required: true,
    searchable: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // U_ (res.users - User/Salesperson) - 2 fields
  // ═══════════════════════════════════════════════════════════════════════════

  U_1: {
    code: 'U_1',
    table: 'res.users',
    field: 'name',
    type: 'char',
    semantic: 'Salesperson or owner name - the person responsible for this opportunity',
    required: false,
    searchable: true,
  },
  U_2: {
    code: 'U_2',
    table: 'res.users',
    field: 'id',
    type: 'integer',
    semantic: 'User ID - unique identifier for the salesperson in Odoo',
    required: false,
    searchable: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // T_ (crm.team - Sales Team) - 2 fields
  // ═══════════════════════════════════════════════════════════════════════════

  T_1: {
    code: 'T_1',
    table: 'crm.team',
    field: 'name',
    type: 'char',
    semantic: 'Sales team name - the team assigned to this opportunity',
    required: false,
    searchable: true,
  },
  T_2: {
    code: 'T_2',
    table: 'crm.team',
    field: 'id',
    type: 'integer',
    semantic: 'Team ID - unique identifier for the sales team',
    required: false,
    searchable: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ST_ (res.country.state - State/Territory) - 2 fields
  // ═══════════════════════════════════════════════════════════════════════════

  ST_1: {
    code: 'ST_1',
    table: 'res.country.state',
    field: 'name',
    type: 'char',
    semantic: 'State or territory name - Victoria, New South Wales, Queensland, South Australia, Western Australia, Tasmania, etc.',
    required: false,
    searchable: true,
  },
  ST_2: {
    code: 'ST_2',
    table: 'res.country.state',
    field: 'id',
    type: 'integer',
    semantic: 'State ID - unique identifier for the state or territory',
    required: false,
    searchable: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LR_ (crm.lost.reason - Lost Reason) - 1 field
  // ═══════════════════════════════════════════════════════════════════════════

  LR_1: {
    code: 'LR_1',
    table: 'crm.lost.reason',
    field: 'name',
    type: 'char',
    semantic: 'Reason the opportunity was lost - why we did not win the deal (price, competitor, timing, etc.)',
    required: false,
    searchable: true,
  },
};

// Get all schema codes as array
export const SCHEMA_CODES = Object.keys(SCHEMA_DEFINITIONS);

// Get schema codes by table
export function getSchemaCodesByTable(table: string): string[] {
  return Object.values(SCHEMA_DEFINITIONS)
    .filter(def => def.table === table)
    .map(def => def.code);
}

// Get searchable schema codes
export function getSearchableCodes(): string[] {
  return Object.values(SCHEMA_DEFINITIONS)
    .filter(def => def.searchable)
    .map(def => def.code);
}

// =============================================================================
// ENCODING CONFIGURATION
// =============================================================================

export const ENCODING_CONFIG = {
  FIELD_DELIMITER: '|',     // Separates fields: O_1*value|O_2*value
  VALUE_DELIMITER: '*',     // Separates code from value: O_1*value
  ESCAPE_CHARS: ['|', '*', '\\'],
} as const;

// =============================================================================
// SIMILARITY THRESHOLDS
// =============================================================================

export const SIMILARITY_THRESHOLDS = {
  VERY_SIMILAR: 0.8,          // Near-duplicate match
  MEANINGFULLY_SIMILAR: 0.6,  // Good semantic match (default)
  LOOSELY_RELATED: 0.4,       // Weak match
  DEFAULT_MIN: 0.6,
} as const;

// =============================================================================
// SYNC CONFIGURATION
// =============================================================================

export const SYNC_CONFIG = {
  BATCH_SIZE: 100,           // Records per batch
  MAX_RECORDS: 10000,        // Maximum records per sync
} as const;
