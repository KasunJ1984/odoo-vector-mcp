/**
 * Encoder Service
 *
 * Transforms Odoo CRM records to/from numeric table-prefixed format.
 *
 * NEW FORMAT: {TABLE_NUMBER}^{COLUMN_NUMBER}*{VALUE}
 *
 * Encoding: CrmLead → "1^1*Hospital Project|1^10*450000|2^1*Hansen Yuncken"
 * Decoding: Encoded string → Structured object with _by_table organization (numeric keys)
 *
 * Tables:
 * 1=Opportunity, 2=Contact, 3=Stage, 4=User, 5=Team,
 * 6=State, 7=LostReason, 8=Specification, 9=LeadSource, 10=Architect
 */

import {
  ENCODING_CONFIG,
  getSchemaByTableColumn,
  TABLE_MAPPING,
} from '../constants.js';
import type { CrmLead, DecodedRecord, DecodedField } from '../types.js';
import { isValidRelation, getRelationName as getRelName, getRelationId as getRelId } from '../types.js';

// =============================================================================
// ENCODING
// =============================================================================

/**
 * Encode a CRM lead (opportunity) to numeric prefixed string format.
 *
 * The encoded string contains:
 * - 1^* fields: Direct values from crm.lead
 * - 2^* fields: Resolved values from partner (res.partner)
 * - 3^* fields: Resolved values from stage (crm.stage)
 * - 4^* fields: Resolved values from user (res.users)
 * - 5^* fields: Resolved values from team (crm.team)
 * - 6^* fields: Resolved values from state (res.country.state)
 * - 7^* fields: Resolved values from lost reason (crm.lost.reason)
 * - 8^* fields: Resolved values from specification (x_specification)
 * - 9^* fields: Resolved values from lead source (x_lead_source)
 * - 10^* fields: Resolved values from architect (res.partner)
 *
 * @param lead CRM lead from Odoo
 * @returns Encoded string
 */
export function encodeOpportunity(lead: CrmLead): string {
  const parts: string[] = [];

  // Helper to add a field using table number and column number
  const addField = (tableNumber: number, columnNumber: number, value: unknown): void => {
    if (value === null || value === undefined || value === false || value === '') {
      return;
    }
    const schema = getSchemaByTableColumn(tableNumber, columnNumber);
    const type = schema?.type || 'char';
    const formatted = formatValue(value, type);
    if (formatted !== null) {
      parts.push(`${tableNumber}${ENCODING_CONFIG.CODE_DELIMITER}${columnNumber}${ENCODING_CONFIG.VALUE_DELIMITER}${formatted}`);
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Table 1: crm.lead - Core opportunity fields
  // ═══════════════════════════════════════════════════════════════════════════

  addField(1, 1, lead.name);                           // name
  addField(1, 2, lead.id);                             // id
  addField(1, 10, lead.expected_revenue);              // expected_revenue
  addField(1, 11, lead.probability);                   // probability
  addField(1, 20, lead.create_date);                   // create_date
  addField(1, 21, lead.write_date);                    // write_date
  addField(1, 22, lead.date_closed);                   // date_closed
  addField(1, 25, cleanDescription(lead.description)); // description
  addField(1, 30, lead.city);                          // city
  addField(1, 40, lead.active);                        // active
  addField(1, 41, lead.is_won);                        // is_won

  // Foreign key IDs (columns 90-99)
  addField(1, 90, getRelId(lead.partner_id));          // partner_id FK
  addField(1, 91, getRelId(lead.stage_id));            // stage_id FK
  addField(1, 92, getRelId(lead.user_id));             // user_id FK
  addField(1, 93, getRelId(lead.team_id));             // team_id FK
  addField(1, 94, getRelId(lead.state_id));            // state_id FK
  addField(1, 95, getRelId(lead.lost_reason_id));      // lost_reason_id FK
  addField(1, 96, getRelId(lead.x_specification_id));  // x_specification_id FK
  addField(1, 97, getRelId(lead.x_lead_source_id));    // x_lead_source_id FK
  addField(1, 98, getRelId(lead.x_architect_id));      // x_architect_id FK

  // ═══════════════════════════════════════════════════════════════════════════
  // Tables 2-10: Resolved names from related tables
  // ═══════════════════════════════════════════════════════════════════════════

  // Table 2: res.partner (Contact)
  if (isValidRelation(lead.partner_id)) {
    addField(2, 1, getRelName(lead.partner_id));
  }

  // Table 3: crm.stage (Stage)
  if (isValidRelation(lead.stage_id)) {
    addField(3, 1, getRelName(lead.stage_id));
  }

  // Table 4: res.users (User)
  if (isValidRelation(lead.user_id)) {
    addField(4, 1, getRelName(lead.user_id));
  }

  // Table 5: crm.team (Team)
  if (isValidRelation(lead.team_id)) {
    addField(5, 1, getRelName(lead.team_id));
  }

  // Table 6: res.country.state (State)
  if (isValidRelation(lead.state_id)) {
    addField(6, 1, getRelName(lead.state_id));
  }

  // Table 7: crm.lost.reason (Lost Reason)
  if (isValidRelation(lead.lost_reason_id)) {
    addField(7, 1, getRelName(lead.lost_reason_id));
  }

  // Table 8: x_specification (Specification)
  if (isValidRelation(lead.x_specification_id)) {
    addField(8, 1, getRelName(lead.x_specification_id));
  }

  // Table 9: x_lead_source (Lead Source)
  if (isValidRelation(lead.x_lead_source_id)) {
    addField(9, 1, getRelName(lead.x_lead_source_id));
  }

  // Table 10: res.partner (Architect)
  if (isValidRelation(lead.x_architect_id)) {
    addField(10, 1, getRelName(lead.x_architect_id));
  }

  return parts.join(ENCODING_CONFIG.FIELD_DELIMITER);
}

// =============================================================================
// DECODING
// =============================================================================

/**
 * Decode an encoded string back to structured data.
 *
 * @param encodedString The encoded string to decode
 * @returns Decoded record with _by_table organization (numeric keys)
 */
export function decode(encodedString: string): DecodedRecord {
  const fields: DecodedField[] = [];
  const schemaCodes: string[] = [];
  const byTable: Record<number, Record<string, unknown>> = {};

  // Split by field delimiter
  const parts = encodedString.split(ENCODING_CONFIG.FIELD_DELIMITER);

  for (const part of parts) {
    // Find the separator between code and value
    const starIndex = part.indexOf(ENCODING_CONFIG.VALUE_DELIMITER);
    if (starIndex === -1) continue;

    const schemaCode = part.substring(0, starIndex);  // e.g., "1^10"
    const rawValue = part.substring(starIndex + 1);

    // Parse the schema code
    const caretIndex = schemaCode.indexOf(ENCODING_CONFIG.CODE_DELIMITER);
    if (caretIndex === -1) continue;

    const tableNumber = parseInt(schemaCode.substring(0, caretIndex), 10);
    const columnNumber = parseInt(schemaCode.substring(caretIndex + 1), 10);

    if (isNaN(tableNumber) || isNaN(columnNumber)) continue;

    // Look up schema definition
    const schemaDef = getSchemaByTableColumn(tableNumber, columnNumber);
    const tableName = schemaDef?.table || TABLE_MAPPING[tableNumber] || 'unknown';
    const fieldName = schemaDef?.field || 'unknown';
    const fieldType = schemaDef?.type || 'char';

    // Parse the value based on type
    const unescaped = unescapeValue(rawValue);
    const parsedValue = parseValue(unescaped, fieldType);

    fields.push({
      code: schemaCode,
      table_number: tableNumber,
      column_number: columnNumber,
      value: unescaped,
      table: tableName,
      field: fieldName,
      type: fieldType,
      parsedValue,
    });

    schemaCodes.push(schemaCode);

    // Organize by table NUMBER (not table name)
    if (!byTable[tableNumber]) {
      byTable[tableNumber] = {};
    }
    byTable[tableNumber][fieldName] = parsedValue;
  }

  return {
    raw: encodedString,
    fields,
    _schema_codes: schemaCodes,
    _by_table: byTable,
  };
}

// =============================================================================
// SEMANTIC TEXT GENERATION
// =============================================================================

/**
 * Build semantic text for embedding.
 *
 * This creates a human-readable description of the opportunity
 * that embeds well for semantic search.
 *
 * @param lead CRM lead from Odoo
 * @returns Human-readable semantic text
 */
export function buildSemanticText(lead: CrmLead): string {
  const parts: string[] = [];

  // Core identity
  parts.push(`Opportunity: ${lead.name}`);

  // Partner (Contact)
  if (isValidRelation(lead.partner_id)) {
    parts.push(`Partner: ${getRelName(lead.partner_id)}`);
  }

  // Stage and status
  if (isValidRelation(lead.stage_id)) {
    parts.push(`Stage: ${getRelName(lead.stage_id)}`);
  }

  // Won/Lost status
  if (lead.is_won === true) {
    parts.push('Status: Won');
  } else if (isValidRelation(lead.lost_reason_id)) {
    parts.push(`Lost Reason: ${getRelName(lead.lost_reason_id)}`);
    parts.push('Status: Lost');
  } else if (lead.active === false) {
    parts.push('Status: Lost');
  }

  // Revenue
  if (lead.expected_revenue) {
    const formatted = formatCurrency(lead.expected_revenue);
    parts.push(`Revenue: ${formatted}`);
  }

  // Probability
  if (lead.probability !== undefined && lead.probability !== null) {
    parts.push(`Probability: ${lead.probability}%`);
  }

  // Location
  const location: string[] = [];
  if (lead.city && typeof lead.city === 'string') location.push(lead.city);
  if (isValidRelation(lead.state_id)) location.push(getRelName(lead.state_id));
  if (location.length > 0) {
    parts.push(`Location: ${location.join(', ')}`);
  }

  // Assignment
  if (isValidRelation(lead.user_id)) {
    parts.push(`Salesperson: ${getRelName(lead.user_id)}`);
  }
  if (isValidRelation(lead.team_id)) {
    parts.push(`Team: ${getRelName(lead.team_id)}`);
  }

  // Specification (new)
  if (isValidRelation(lead.x_specification_id)) {
    parts.push(`Specification: ${getRelName(lead.x_specification_id)}`);
  }

  // Lead Source (new)
  if (isValidRelation(lead.x_lead_source_id)) {
    parts.push(`Lead Source: ${getRelName(lead.x_lead_source_id)}`);
  }

  // Architect (new)
  if (isValidRelation(lead.x_architect_id)) {
    parts.push(`Architect: ${getRelName(lead.x_architect_id)}`);
  }

  // Description (truncated)
  const desc = cleanDescription(lead.description);
  if (desc) {
    const truncated = desc.length > 500 ? desc.slice(0, 500) + '...' : desc;
    parts.push(`Notes: ${truncated}`);
  }

  return parts.join(' | ');
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Format value for encoding based on type
 */
function formatValue(value: unknown, type: string): string | null {
  if (value === null || value === undefined) return null;

  switch (type) {
    case 'integer':
      const intVal = parseInt(String(value), 10);
      return isNaN(intVal) ? null : String(intVal);

    case 'float':
      const floatVal = parseFloat(String(value));
      return isNaN(floatVal) ? null : floatVal.toFixed(2);

    case 'boolean':
      return value ? 'true' : 'false';

    case 'char':
    case 'text':
    case 'selection':
    case 'date':
    case 'datetime':
    default:
      const str = String(value).trim();
      return str ? escapeValue(str) : null;
  }
}

/**
 * Parse value from encoded string
 */
function parseValue(value: string, type: string): unknown {
  switch (type) {
    case 'integer':
      return parseInt(value, 10);

    case 'float':
      return parseFloat(value);

    case 'boolean':
      return value === 'true';

    default:
      return value;
  }
}

/**
 * Escape special characters in value
 *
 * Must escape: | * \ ^
 */
function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')   // Escape backslash first
    .replace(/\|/g, '\\|')    // Escape field delimiter
    .replace(/\*/g, '\\*')    // Escape value delimiter
    .replace(/\^/g, '\\^');   // Escape code delimiter (NEW)
}

/**
 * Unescape special characters in value
 */
function unescapeValue(value: string): string {
  return value
    .replace(/\\\^/g, '^')    // Unescape code delimiter (NEW)
    .replace(/\\\*/g, '*')    // Unescape value delimiter
    .replace(/\\\|/g, '|')    // Unescape field delimiter
    .replace(/\\\\/g, '\\');  // Unescape backslash last
}

/**
 * Clean HTML from description
 */
function cleanDescription(description: string | false | undefined): string {
  if (!description || typeof description !== 'string') return '';

  // Simple HTML tag removal
  return description
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Format currency for display (AUD)
 */
function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}
