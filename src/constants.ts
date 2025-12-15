/**
 * Constants for odoo-vector-mcp
 *
 * Redesigned for comprehensive Odoo schema search using 4^XX* encoding format.
 * Phase 1: Schema semantic search
 * Phase 2: Will use Odoo config for data extraction
 */

// =============================================================================
// ENVIRONMENT CONFIGURATION
// =============================================================================

/**
 * Odoo configuration (KEPT FOR PHASE 2)
 */
export const ODOO_CONFIG = {
  URL: process.env.ODOO_URL || '',
  DB: process.env.ODOO_DB || '',
  USERNAME: process.env.ODOO_USERNAME || '',
  PASSWORD: process.env.ODOO_PASSWORD || '',
} as const;

/**
 * Qdrant vector database configuration
 */
export const QDRANT_CONFIG = {
  HOST: process.env.QDRANT_HOST || 'http://localhost:6333',
  API_KEY: process.env.QDRANT_API_KEY || '',
  COLLECTION: process.env.SCHEMA_COLLECTION_NAME || 'odoo_schema',
  VECTOR_SIZE: parseInt(process.env.VECTOR_SIZE || process.env.EMBEDDING_DIMENSIONS || '512', 10),
  DISTANCE_METRIC: 'Cosine' as const,
  // Scalar Quantization: Reduces memory by 75% (float32 → int8)
  // Set ENABLE_SCALAR_QUANTIZATION=false to disable
  ENABLE_SCALAR_QUANTIZATION: process.env.ENABLE_SCALAR_QUANTIZATION !== 'false',
  SCALAR_QUANTILE: parseFloat(process.env.SCALAR_QUANTILE || '0.99'),
  // Search optimization params for quantized vectors
  SEARCH_RESCORE: process.env.SEARCH_RESCORE !== 'false',
  SEARCH_OVERSAMPLING: parseFloat(process.env.SEARCH_OVERSAMPLING || '2.0'),
  // HNSW Configuration (tuned for 150K+ vectors in single collection)
  // m: connections per node - higher = better recall, more memory
  // ef_construct: build-time quality - one-time cost
  // ef_search: query-time exploration - higher = better recall, slower
  HNSW_M: parseInt(process.env.HNSW_M || '32', 10),
  HNSW_EF_CONSTRUCT: parseInt(process.env.HNSW_EF_CONSTRUCT || '200', 10),
  HNSW_EF_SEARCH: parseInt(process.env.HNSW_EF_SEARCH || '128', 10),
} as const;

/**
 * Voyage AI embedding configuration
 */
export const VOYAGE_CONFIG = {
  API_KEY: process.env.VOYAGE_API_KEY || '',
  MODEL: process.env.EMBEDDING_MODEL || 'voyage-3.5-lite',
  DIMENSIONS: parseInt(process.env.VECTOR_SIZE || process.env.EMBEDDING_DIMENSIONS || '512', 10),
  MAX_BATCH_SIZE: 128,
  INPUT_TYPE_DOCUMENT: 'document' as const,
  INPUT_TYPE_QUERY: 'query' as const,
} as const;

// =============================================================================
// SCHEMA DATA CONFIGURATION
// =============================================================================

/**
 * Schema data file path
 */
export const SCHEMA_CONFIG = {
  DATA_FILE: process.env.SCHEMA_DATA_FILE || 'data/odoo_schema.txt',
  FIELD_DELIMITER: '|',    // Separates fields in encoded row
  VALUE_DELIMITER: '*',    // Separates prefix code from value
} as const;

/**
 * Prefix codes for parsing the 4^XX* format
 *
 * Each column in the encoded schema has a unique prefix:
 * - 4^58: Numeric IDs (Model_ID, Field_ID)
 * - 4^26: Field name (technical)
 * - 4^33: Field label (display name)
 * - 4^35: Field type
 * - 4^28: Model name
 * - 4^60000: Primary data location
 * - 4^57: Stored flag (Yes/No)
 * - 4^60001: Primary reference (Model_ID^Field_ID)
 */
export const SCHEMA_PREFIX_CODES = {
  NUMERIC_ID: '4^58',          // Model_ID, Field_ID (columns 1 and 2)
  FIELD_NAME: '4^26',          // Technical name (column 3)
  FIELD_LABEL: '4^33',         // Display label (column 4)
  FIELD_TYPE: '4^35',          // Type - char, many2one, etc. (column 5)
  MODEL_NAME: '4^28',          // Model name (column 6)
  PRIMARY_LOCATION: '4^60000', // Where data lives (column 7)
  STORED: '4^57',              // Yes/No (column 8)
  PRIMARY_REF: '4^60001',      // Model_ID^Field_ID reference (column 9)
} as const;

/**
 * Column positions in the encoded schema row (0-indexed)
 *
 * Row format:
 * [0] 4^58*Model_ID | [1] 4^58*Field_ID | [2] 4^26*field_name | [3] 4^33*Label |
 * [4] 4^35*type | [5] 4^28*model.name | [6] 4^60000*primary.location |
 * [7] 4^57*Yes/No | [8] 4^60001*ModelID^FieldID*
 */
export const SCHEMA_COLUMN_INDEX = {
  MODEL_ID: 0,
  FIELD_ID: 1,
  FIELD_NAME: 2,
  FIELD_LABEL: 3,
  FIELD_TYPE: 4,
  MODEL_NAME: 5,
  PRIMARY_LOCATION: 6,
  STORED: 7,
  PRIMARY_REF: 8,
} as const;

// =============================================================================
// SIMILARITY THRESHOLDS
// =============================================================================

/**
 * Similarity score thresholds for semantic search
 */
export const SIMILARITY_THRESHOLDS = {
  VERY_SIMILAR: 0.8,           // Near-duplicate
  MEANINGFULLY_SIMILAR: 0.6,   // Good match (default)
  LOOSELY_RELATED: 0.4,        // Weak match
  DEFAULT_MIN: 0.5,            // Default minimum score
} as const;

// =============================================================================
// SYNC CONFIGURATION
// =============================================================================

/**
 * Batch sizes for sync operations
 */
export const SYNC_CONFIG = {
  BATCH_SIZE: 100,             // Records per batch for embedding
  MAX_RECORDS: 20000,          // Maximum records to process (17,930 fields)
  TIMEOUT_MS: 30000,           // Timeout for API calls
} as const;

// =============================================================================
// SEARCH DEFAULTS
// =============================================================================

/**
 * Default search parameters
 */
export const SEARCH_DEFAULTS = {
  LIMIT: 10,                   // Default number of results
  MAX_LIMIT: 50,               // Maximum results per query
  MIN_SIMILARITY: 0.5,         // Default minimum similarity
} as const;

// =============================================================================
// CACHE CONFIGURATION
// =============================================================================

/**
 * LRU Query Cache configuration
 *
 * Caches search results to avoid redundant Qdrant queries.
 * Especially valuable with scalar quantization (rescore overhead).
 * Cleared automatically after schema sync.
 */
export const CACHE_CONFIG = {
  MAX_ENTRIES: parseInt(process.env.CACHE_MAX_ENTRIES || '500', 10),
  TTL_MS: parseInt(process.env.CACHE_TTL_MS || '1800000', 10), // 30 minutes
  ENABLED: process.env.CACHE_ENABLED !== 'false',
} as const;

// =============================================================================
// DATA TRANSFORMER CONFIGURATION (Phase 2 - Data Encoding)
// =============================================================================

/**
 * Data transformer configuration
 *
 * Transforms Odoo table data into coordinate-encoded format:
 * [model_id]^[field_id]*VALUE
 *
 * Example: 344^6327*12345|344^6299*50000|78^956*201
 *
 * NOTE: Model configurations are now DYNAMIC!
 * The tool automatically discovers model_id and id_field_id from the schema.
 * Just use: transfer_[model.name]_1984
 * Examples:
 * - transfer_crm.lead_1984
 * - transfer_res.partner_1984
 * - transfer_sale.order_1984
 */
export const DATA_TRANSFORM_CONFIG = {
  /** Records per Odoo API call */
  FETCH_BATCH_SIZE: 200,
  /** Records per embedding API call */
  EMBED_BATCH_SIZE: 100,
  /**
   * Point ID multiplier to ensure no clash with schema field_ids
   * Point ID = model_id * 10_000_000 + record_id
   * Example: crm.lead (344) record 12345 = 3440012345
   */
  MODEL_ID_MULTIPLIER: 10_000_000,
  /** Trigger code required to confirm data sync */
  SYNC_CODE: '1984',
} as const;

// =============================================================================
// NEXUS KEY FIELDS CONFIGURATION
// =============================================================================

/**
 * Key fields to display for each model in decoded NEXUS output
 *
 * These fields are shown first and always displayed in search results.
 * The analytics system will suggest additional fields based on usage.
 *
 * Field order determines display priority (first = most important).
 */
export const KEY_FIELDS_CONFIG: Record<string, readonly string[]> = {
  'crm.lead': [
    'name',              // Opportunity name (most important)
    'expected_revenue',  // Deal value
    'probability',       // Win probability %
    'partner_id',        // Customer (FK → res.partner)
    'stage_id',          // Pipeline stage (FK → crm.stage)
    'user_id',           // Salesperson (FK → res.users)
    'city',              // Location
    'active',            // Active/Archived status
  ],
  // Future models can be added:
  // 'res.partner': ['name', 'email', 'phone', 'city', 'is_company'],
  // 'crm.stage': ['name', 'sequence'],
} as const;

// =============================================================================
// NEXUS ANALYTICS CONFIGURATION
// =============================================================================

/**
 * Configuration for the self-improving analytics system
 *
 * The analytics service tracks field usage to discover which fields
 * are most important to users and automatically suggests promotions.
 */
export const ANALYTICS_CONFIG = {
  /** File path for persisted analytics data */
  DATA_FILE: 'data/analytics.json',
  /** Maximum number of field usage records to track */
  MAX_FIELD_ENTRIES: 5000,
  /** How often to persist analytics to disk (ms) */
  PERSIST_INTERVAL_MS: 60000, // 1 minute
  /** Clear analytics when schema changes */
  CLEAR_ON_SCHEMA_CHANGE: true,
  /** Minimum score (0-100) to promote a field to key fields */
  PROMOTION_THRESHOLD: 50,
  /** Maximum key fields per model */
  MAX_KEY_FIELDS: 12,
} as const;

// =============================================================================
// NEXUS TRAINING DATA CONFIGURATION
// =============================================================================

/**
 * Configuration for training data collection (Phase 2 preparation)
 *
 * Training pairs (NEXUS encoded → human readable) are collected
 * during decode operations for future model training.
 */
export const TRAINING_CONFIG = {
  /** Maximum number of training pairs to keep in memory */
  MAX_PAIRS: 10000,
  /** File path for persisted training data */
  DATA_FILE: 'data/training.json',
} as const;
