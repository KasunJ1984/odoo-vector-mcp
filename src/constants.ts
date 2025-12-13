/**
 * Constants for odoo-vector-mcp
 *
 * This file defines the numeric table-prefixed encoding system.
 * Each numeric prefix indicates which Odoo table the field comes from,
 * providing clear data lineage in the encoded strings.
 *
 * NEW FORMAT: {TABLE_NUMBER}^{COLUMN_NUMBER}*{VALUE}
 * Example: 1^10*450000|2^1*Hansen|3^1*Tender RFQ
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
  VECTOR_SIZE: parseInt(process.env.EMBEDDING_DIMENSIONS || '1024', 10),
  DISTANCE_METRIC: 'Cosine' as const,
} as const;

export const VOYAGE_CONFIG = {
  API_KEY: process.env.VOYAGE_API_KEY || '',
  MODEL: process.env.EMBEDDING_MODEL || 'voyage-3',
  DIMENSIONS: parseInt(process.env.EMBEDDING_DIMENSIONS || '1024', 10),
  MAX_BATCH_SIZE: 128,
  INPUT_TYPE_DOCUMENT: 'document' as const,
  INPUT_TYPE_QUERY: 'query' as const,
} as const;

// =============================================================================
// TABLE MAPPING (Numeric IDs)
// =============================================================================

/**
 * TABLE MAPPING - The core of the self-describing architecture
 *
 * Each number identifies which Odoo table the field comes from:
 * - 1  = crm.lead (Opportunity)
 * - 2  = res.partner (Contact/Company)
 * - 3  = crm.stage (Pipeline Stage)
 * - 4  = res.users (User/Salesperson)
 * - 5  = crm.team (Sales Team)
 * - 6  = res.country.state (State/Territory)
 * - 7  = crm.lost.reason (Lost Reason)
 * - 8  = x_specification (Specification - Custom)
 * - 9  = x_lead_source (Lead Source - Custom)
 * - 10 = res.partner (Architect - same table, different role)
 */
export const TABLE_MAPPING: Record<number, string> = {
  1: 'crm.lead',
  2: 'res.partner',
  3: 'crm.stage',
  4: 'res.users',
  5: 'crm.team',
  6: 'res.country.state',
  7: 'crm.lost.reason',
  8: 'x_specification',
  9: 'x_lead_source',
  10: 'res.partner', // Architect (same table, different role)
};

export const REVERSE_TABLE_MAPPING: Record<string, number> = {
  'crm.lead': 1,
  'res.partner': 2,
  'crm.stage': 3,
  'res.users': 4,
  'crm.team': 5,
  'res.country.state': 6,
  'crm.lost.reason': 7,
  'x_specification': 8,
  'x_lead_source': 9,
  // Note: Architect uses table 10 but maps to res.partner
};

// Table display names for human-readable output
export const TABLE_DISPLAY_NAMES: Record<number, string> = {
  1: 'Opportunity',
  2: 'Contact',
  3: 'Stage',
  4: 'User',
  5: 'Team',
  6: 'State',
  7: 'Lost Reason',
  8: 'Specification',
  9: 'Lead Source',
  10: 'Architect',
};

// =============================================================================
// SCHEMA DEFINITIONS (~35 fields)
// =============================================================================

/**
 * Each schema definition maps a numeric code to its source and semantic meaning.
 *
 * Code Format: {TABLE_NUMBER}^{COLUMN_NUMBER}
 *
 * Column Number Ranges:
 *   - 1-9:   Primary identifiers (name, id)
 *   - 10-19: Numeric/financial fields
 *   - 20-29: Date/time fields
 *   - 30-39: Location fields
 *   - 40-49: Boolean/status fields
 *   - 50-59: Custom/classification fields
 *   - 90-99: Foreign key IDs
 */
export interface SchemaDefinition {
  table_number: number;     // e.g., 1
  column_number: number;    // e.g., 10
  table: string;            // e.g., "crm.lead"
  field: string;            // e.g., "expected_revenue"
  type: 'char' | 'integer' | 'float' | 'text' | 'datetime' | 'date' | 'boolean' | 'selection';
  semantic: string;         // Human-readable description for embedding
  required: boolean;        // Is this field required?
  searchable: boolean;      // Should this be included in semantic text?
}

// Helper to get schema code string
export function getSchemaCode(def: SchemaDefinition): string {
  return `${def.table_number}^${def.column_number}`;
}

// Helper to get schema by table and column
export function getSchemaByTableColumn(tableNumber: number, columnNumber: number): SchemaDefinition | undefined {
  return SCHEMA_DEFINITIONS.find(
    def => def.table_number === tableNumber && def.column_number === columnNumber
  );
}

// Helper to get schema by code string
export function getSchemaByCode(code: string): SchemaDefinition | undefined {
  const caretIndex = code.indexOf('^');
  if (caretIndex === -1) return undefined;

  const tableNumber = parseInt(code.substring(0, caretIndex), 10);
  const columnNumber = parseInt(code.substring(caretIndex + 1), 10);

  return getSchemaByTableColumn(tableNumber, columnNumber);
}

export const SCHEMA_DEFINITIONS: SchemaDefinition[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // Table 1 (crm.lead - Opportunity) - Core Fields
  // ═══════════════════════════════════════════════════════════════════════════

  {
    table_number: 1,
    column_number: 1,
    table: 'crm.lead',
    field: 'name',
    type: 'char',
    semantic: 'Opportunity name or project title - describes the deal being pursued',
    required: true,
    searchable: true,
  },
  {
    table_number: 1,
    column_number: 2,
    table: 'crm.lead',
    field: 'id',
    type: 'integer',
    semantic: 'Unique opportunity identifier in Odoo CRM system',
    required: true,
    searchable: false,
  },
  {
    table_number: 1,
    column_number: 10,
    table: 'crm.lead',
    field: 'expected_revenue',
    type: 'float',
    semantic: 'Expected revenue or deal value in dollars - the potential income from this opportunity',
    required: false,
    searchable: true,
  },
  {
    table_number: 1,
    column_number: 11,
    table: 'crm.lead',
    field: 'probability',
    type: 'integer',
    semantic: 'Win probability percentage from 0 to 100 - likelihood of closing the deal',
    required: false,
    searchable: true,
  },
  {
    table_number: 1,
    column_number: 20,
    table: 'crm.lead',
    field: 'create_date',
    type: 'datetime',
    semantic: 'Date and time when the opportunity was created in the system',
    required: true,
    searchable: false,
  },
  {
    table_number: 1,
    column_number: 21,
    table: 'crm.lead',
    field: 'write_date',
    type: 'datetime',
    semantic: 'Date and time when the opportunity was last modified',
    required: false,
    searchable: false,
  },
  {
    table_number: 1,
    column_number: 22,
    table: 'crm.lead',
    field: 'date_closed',
    type: 'date',
    semantic: 'Date when the opportunity was won or lost - the closing date',
    required: false,
    searchable: false,
  },
  {
    table_number: 1,
    column_number: 25,
    table: 'crm.lead',
    field: 'description',
    type: 'text',
    semantic: 'Detailed description, notes, and context about the opportunity',
    required: false,
    searchable: true,
  },
  {
    table_number: 1,
    column_number: 30,
    table: 'crm.lead',
    field: 'city',
    type: 'char',
    semantic: 'City where the project or opportunity is located',
    required: false,
    searchable: true,
  },
  {
    table_number: 1,
    column_number: 40,
    table: 'crm.lead',
    field: 'active',
    type: 'boolean',
    semantic: 'Whether the opportunity is active (true) or archived (false)',
    required: false,
    searchable: false,
  },
  {
    table_number: 1,
    column_number: 41,
    table: 'crm.lead',
    field: 'is_won',
    type: 'boolean',
    semantic: 'Whether the opportunity has been won (true) or not (false)',
    required: false,
    searchable: true,
  },
  {
    table_number: 1,
    column_number: 50,
    table: 'crm.lead',
    field: 'x_sector',
    type: 'selection',
    semantic: 'Industry sector classification - Education, Healthcare, Commercial, Residential, Government',
    required: false,
    searchable: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Table 1 (crm.lead) - Foreign Key IDs (90-99)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    table_number: 1,
    column_number: 90,
    table: 'crm.lead',
    field: 'partner_id',
    type: 'integer',
    semantic: 'Foreign key to Contact/Company (res.partner) - links opportunity to customer',
    required: false,
    searchable: false,
  },
  {
    table_number: 1,
    column_number: 91,
    table: 'crm.lead',
    field: 'stage_id',
    type: 'integer',
    semantic: 'Foreign key to Pipeline Stage (crm.stage) - current stage in sales process',
    required: false,
    searchable: false,
  },
  {
    table_number: 1,
    column_number: 92,
    table: 'crm.lead',
    field: 'user_id',
    type: 'integer',
    semantic: 'Foreign key to Salesperson (res.users) - assigned owner',
    required: false,
    searchable: false,
  },
  {
    table_number: 1,
    column_number: 93,
    table: 'crm.lead',
    field: 'team_id',
    type: 'integer',
    semantic: 'Foreign key to Sales Team (crm.team) - assigned team',
    required: false,
    searchable: false,
  },
  {
    table_number: 1,
    column_number: 94,
    table: 'crm.lead',
    field: 'state_id',
    type: 'integer',
    semantic: 'Foreign key to State/Territory (res.country.state) - location',
    required: false,
    searchable: false,
  },
  {
    table_number: 1,
    column_number: 95,
    table: 'crm.lead',
    field: 'lost_reason_id',
    type: 'integer',
    semantic: 'Foreign key to Lost Reason (crm.lost.reason) - why deal was lost',
    required: false,
    searchable: false,
  },
  {
    table_number: 1,
    column_number: 96,
    table: 'crm.lead',
    field: 'x_specification_id',
    type: 'integer',
    semantic: 'Foreign key to Specification (x_specification) - project specification type',
    required: false,
    searchable: false,
  },
  {
    table_number: 1,
    column_number: 97,
    table: 'crm.lead',
    field: 'x_lead_source_id',
    type: 'integer',
    semantic: 'Foreign key to Lead Source (x_lead_source) - where the lead came from',
    required: false,
    searchable: false,
  },
  {
    table_number: 1,
    column_number: 98,
    table: 'crm.lead',
    field: 'x_architect_id',
    type: 'integer',
    semantic: 'Foreign key to Architect (res.partner) - architect contact for the project',
    required: false,
    searchable: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Table 2 (res.partner - Contact/Company)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    table_number: 2,
    column_number: 1,
    table: 'res.partner',
    field: 'name',
    type: 'char',
    semantic: 'Contact or company name - the business entity associated with the opportunity',
    required: true,
    searchable: true,
  },
  {
    table_number: 2,
    column_number: 2,
    table: 'res.partner',
    field: 'id',
    type: 'integer',
    semantic: 'Partner ID - unique identifier for the contact or company in Odoo',
    required: true,
    searchable: false,
  },
  {
    table_number: 2,
    column_number: 10,
    table: 'res.partner',
    field: 'email',
    type: 'char',
    semantic: 'Contact email address for communication',
    required: false,
    searchable: true,
  },
  {
    table_number: 2,
    column_number: 11,
    table: 'res.partner',
    field: 'phone',
    type: 'char',
    semantic: 'Contact phone number for communication',
    required: false,
    searchable: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Table 3 (crm.stage - Pipeline Stage)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    table_number: 3,
    column_number: 1,
    table: 'crm.stage',
    field: 'name',
    type: 'char',
    semantic: 'Pipeline stage name - where the opportunity is in the sales process (New, Qualification, Proposal, Negotiation, Won, Lost)',
    required: true,
    searchable: true,
  },
  {
    table_number: 3,
    column_number: 2,
    table: 'crm.stage',
    field: 'id',
    type: 'integer',
    semantic: 'Stage ID - unique identifier for the pipeline stage',
    required: true,
    searchable: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Table 4 (res.users - User/Salesperson)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    table_number: 4,
    column_number: 1,
    table: 'res.users',
    field: 'name',
    type: 'char',
    semantic: 'Salesperson or owner name - the person responsible for this opportunity',
    required: false,
    searchable: true,
  },
  {
    table_number: 4,
    column_number: 2,
    table: 'res.users',
    field: 'id',
    type: 'integer',
    semantic: 'User ID - unique identifier for the salesperson in Odoo',
    required: false,
    searchable: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Table 5 (crm.team - Sales Team)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    table_number: 5,
    column_number: 1,
    table: 'crm.team',
    field: 'name',
    type: 'char',
    semantic: 'Sales team name - the team assigned to this opportunity',
    required: false,
    searchable: true,
  },
  {
    table_number: 5,
    column_number: 2,
    table: 'crm.team',
    field: 'id',
    type: 'integer',
    semantic: 'Team ID - unique identifier for the sales team',
    required: false,
    searchable: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Table 6 (res.country.state - State/Territory)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    table_number: 6,
    column_number: 1,
    table: 'res.country.state',
    field: 'name',
    type: 'char',
    semantic: 'State or territory name - Victoria, New South Wales, Queensland, South Australia, Western Australia, Tasmania, etc.',
    required: false,
    searchable: true,
  },
  {
    table_number: 6,
    column_number: 2,
    table: 'res.country.state',
    field: 'id',
    type: 'integer',
    semantic: 'State ID - unique identifier for the state or territory',
    required: false,
    searchable: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Table 7 (crm.lost.reason - Lost Reason)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    table_number: 7,
    column_number: 1,
    table: 'crm.lost.reason',
    field: 'name',
    type: 'char',
    semantic: 'Reason the opportunity was lost - why we did not win the deal (price, competitor, timing, etc.)',
    required: false,
    searchable: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Table 8 (x_specification - Specification)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    table_number: 8,
    column_number: 1,
    table: 'x_specification',
    field: 'x_name',
    type: 'char',
    semantic: 'Specification name - type of project specification (e.g., Duracube, Open Spec, Closed Spec)',
    required: false,
    searchable: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Table 9 (x_lead_source - Lead Source)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    table_number: 9,
    column_number: 1,
    table: 'x_lead_source',
    field: 'x_name',
    type: 'char',
    semantic: 'Lead source name - where the lead originated (e.g., Website, Referral, Trade Show, Cold Call)',
    required: false,
    searchable: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Table 10 (res.partner - Architect)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    table_number: 10,
    column_number: 1,
    table: 'res.partner',
    field: 'name',
    type: 'char',
    semantic: 'Architect name - the architect or architecture firm associated with the project',
    required: false,
    searchable: true,
  },
];

// Get all schema codes as array
export function getAllSchemaCodes(): string[] {
  return SCHEMA_DEFINITIONS.map(def => getSchemaCode(def));
}

// Get schema codes by table number
export function getSchemaCodesByTable(tableNumber: number): string[] {
  return SCHEMA_DEFINITIONS
    .filter(def => def.table_number === tableNumber)
    .map(def => getSchemaCode(def));
}

// Get searchable schema definitions
export function getSearchableSchemas(): SchemaDefinition[] {
  return SCHEMA_DEFINITIONS.filter(def => def.searchable);
}

// Get searchable schema codes
export function getSearchableCodes(): string[] {
  return getSearchableSchemas().map(def => getSchemaCode(def));
}

// =============================================================================
// ENCODING CONFIGURATION
// =============================================================================

export const ENCODING_CONFIG = {
  FIELD_DELIMITER: '|',     // Separates fields: 1^1*value|1^10*value
  VALUE_DELIMITER: '*',     // Separates code from value: 1^10*value
  CODE_DELIMITER: '^',      // Separates table from column: 1^10
  ESCAPE_CHARS: ['|', '*', '\\', '^'],
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
