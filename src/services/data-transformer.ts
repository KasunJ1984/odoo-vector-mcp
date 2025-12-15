/**
 * Data Transformer Service
 *
 * Transforms Odoo table data into coordinate-encoded format for embedding.
 * Encoding format: [model_id]^[field_id]*VALUE
 *
 * Example encoded record:
 * 344^6327*12345|344^6299*450000|78^956*201|345^6237*4
 *
 * Key features:
 * - Schema validation: Every Odoo field must have a schema entry
 * - FK prefix rule: Foreign keys use TARGET model's prefix
 * - Type-aware encoding: Boolean → TRUE/FALSE, many2one → ID only, etc.
 */

import { getSchemasByModel } from './schema-loader.js';
import type {
  OdooSchemaRow,
  FieldEncodingMap,
  EncodedRecord,
  ValidationResult,
  DataTransformConfig,
} from '../types.js';

// =============================================================================
// SCHEMA VALIDATION
// =============================================================================

/**
 * Validate that all Odoo fields have corresponding schema entries
 *
 * This is a CRITICAL control to ensure the "connected structure and map".
 * Sync will FAIL if any Odoo field is not defined in the schema.
 *
 * @param odooFields - Field names from Odoo record
 * @param schemaFields - Schema rows for the model
 * @returns ValidationResult with matched/missing field lists
 */
export function validateSchemaDataAlignment(
  odooFields: string[],
  schemaFields: OdooSchemaRow[]
): ValidationResult {
  const schemaFieldNames = new Set(schemaFields.map(f => f.field_name));
  const odooFieldSet = new Set(odooFields);

  const missing_in_schema = odooFields.filter(f => !schemaFieldNames.has(f));
  const missing_in_odoo = schemaFields
    .filter(f => !odooFieldSet.has(f.field_name))
    .map(f => f.field_name);
  const matched_fields = odooFields.filter(f => schemaFieldNames.has(f));

  return {
    valid: missing_in_schema.length === 0, // FAIL if any Odoo field not in schema
    matched_fields,
    missing_in_schema,
    missing_in_odoo,
  };
}

// =============================================================================
// FIELD ENCODING MAP
// =============================================================================

/**
 * Build encoding map: field_name → encoding prefix
 *
 * CRITICAL RULE for foreign keys:
 * - many2one fields use the TARGET model's id field prefix
 * - Example: partner_id (many2one to res.partner) → uses "78^956" (res.partner.id prefix)
 * - NOT "344^XXX" (crm.lead's own prefix)
 *
 * For native fields:
 * - Use the model's own model_id^field_id
 * - Example: expected_revenue → "344^6299"
 *
 * @param modelFields - Schema rows for the model
 * @returns FieldEncodingMap
 */
export function buildFieldEncodingMap(modelFields: OdooSchemaRow[]): FieldEncodingMap {
  const map: FieldEncodingMap = {};

  for (const field of modelFields) {
    if (field.field_type === 'many2one') {
      // FK: Use TARGET model's id field prefix (primary_model_id^primary_field_id)
      map[field.field_name] = {
        prefix: `${field.primary_model_id}^${field.primary_field_id}`,
        field_type: field.field_type,
        is_foreign_key: true,
        target_model: field.primary_data_location.replace('.id', ''),
      };
    } else if (field.field_type === 'many2many' || field.field_type === 'one2many') {
      // For many2many/one2many, use the model's own prefix
      map[field.field_name] = {
        prefix: `${field.model_id}^${field.field_id}`,
        field_type: field.field_type,
        is_foreign_key: true,
        target_model: field.primary_data_location.replace('.id', ''),
      };
    } else {
      // Native field: Use model's own model_id^field_id
      map[field.field_name] = {
        prefix: `${field.model_id}^${field.field_id}`,
        field_type: field.field_type,
        is_foreign_key: false,
      };
    }
  }

  return map;
}

// =============================================================================
// VALUE ENCODING
// =============================================================================

/**
 * Encode a value based on its field type
 *
 * Type mappings:
 * - boolean: TRUE / FALSE
 * - many2one: Extract ID from [id, name] tuple
 * - many2many/one2many: [1,2,3] format
 * - char/text: As-is (escape | delimiter)
 * - integer/float/monetary: As string
 * - date/datetime: As string
 * - false/null: Empty string (will be included in encoded string)
 *
 * @param value - Raw value from Odoo
 * @param fieldType - Field type from schema
 * @returns Encoded string value
 */
export function encodeValue(value: unknown, fieldType: string): string {
  // Handle boolean FIRST - false is a valid boolean value
  if (fieldType === 'boolean') {
    // Odoo returns false for empty fields too, so only TRUE if explicitly true
    return value === true ? 'TRUE' : 'FALSE';
  }

  // Handle falsy values (Odoo returns false for empty fields)
  if (value === false || value === null || value === undefined) {
    return '';
  }

  switch (fieldType) {
    case 'many2one':
      // Odoo returns [id, name] tuple for many2one
      if (Array.isArray(value) && value.length === 2) {
        return String(value[0]); // Return just the ID
      }
      return '';

    case 'many2many':
    case 'one2many':
      // Return as array format [1,2,3]
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return '[]';
        }
        return `[${value.join(',')}]`;
      }
      return '[]';

    case 'integer':
    case 'float':
    case 'monetary':
      return String(value);

    case 'char':
    case 'text':
    case 'html':
      // Escape pipe characters that would break our delimiter
      return String(value).replace(/\|/g, '\\|');

    case 'date':
    case 'datetime':
      return String(value);

    case 'selection':
      return String(value);

    case 'binary':
      // Binary fields are typically base64 encoded - skip for now
      return value ? '[binary]' : '';

    default:
      return String(value);
  }
}

// =============================================================================
// RECORD ENCODING
// =============================================================================

/**
 * Encode a single Odoo record into coordinate format
 *
 * Format: 344^6327*12345|344^6299*450000|78^956*201|...
 *
 * @param record - Raw Odoo record from searchRead
 * @param encodingMap - Field name to prefix mapping
 * @returns Encoded string
 */
export function encodeRecord(
  record: Record<string, unknown>,
  encodingMap: FieldEncodingMap
): string {
  const parts: string[] = [];

  for (const [fieldName, fieldInfo] of Object.entries(encodingMap)) {
    const value = record[fieldName];
    const encodedValue = encodeValue(value, fieldInfo.field_type);

    // Include the field even if value is empty (preserves field structure)
    parts.push(`${fieldInfo.prefix}*${encodedValue}`);
  }

  return parts.join('|');
}

// =============================================================================
// BATCH TRANSFORMATION
// =============================================================================

/**
 * Get model fields from schema
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns Array of schema rows for the model
 */
export function getModelFields(modelName: string): OdooSchemaRow[] {
  return getSchemasByModel(modelName);
}

/**
 * Transform a batch of Odoo records into encoded records
 *
 * @param records - Raw Odoo records
 * @param encodingMap - Field encoding map
 * @param config - Transform configuration
 * @returns Array of encoded records
 */
export function transformRecords(
  records: Record<string, unknown>[],
  encodingMap: FieldEncodingMap,
  config: DataTransformConfig
): EncodedRecord[] {
  const encodedRecords: EncodedRecord[] = [];

  for (const record of records) {
    const encodedString = encodeRecord(record, encodingMap);
    encodedRecords.push({
      record_id: record.id as number,
      model_name: config.model_name,
      model_id: config.model_id,
      encoded_string: encodedString,
      field_count: encodedString.split('|').length,
    });
  }

  return encodedRecords;
}

/**
 * Get the list of field names to fetch from Odoo
 * Only fetches fields that exist in the schema
 *
 * @param encodingMap - Field encoding map
 * @returns Array of field names
 */
export function getFieldsToFetch(encodingMap: FieldEncodingMap): string[] {
  return Object.keys(encodingMap);
}

/**
 * Preview the encoding map for a model (for debugging/validation)
 *
 * @param modelName - Model name
 * @returns Object with encoding map and field count
 */
export function previewEncodingMap(modelName: string): {
  model_name: string;
  field_count: number;
  encoding_map: FieldEncodingMap;
  sample_prefixes: { field_name: string; prefix: string; type: string }[];
} {
  const schemaFields = getModelFields(modelName);

  if (schemaFields.length === 0) {
    throw new Error(`No schema found for model: ${modelName}`);
  }

  const encodingMap = buildFieldEncodingMap(schemaFields);

  // Get sample of prefixes for display
  const samplePrefixes = Object.entries(encodingMap)
    .slice(0, 20)
    .map(([fieldName, info]) => ({
      field_name: fieldName,
      prefix: info.prefix,
      type: info.field_type,
    }));

  return {
    model_name: modelName,
    field_count: schemaFields.length,
    encoding_map: encodingMap,
    sample_prefixes: samplePrefixes,
  };
}
