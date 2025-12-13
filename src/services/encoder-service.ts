/**
 * Encoder Service
 *
 * Transforms Odoo CRM records to/from source-table-prefixed format.
 *
 * Encoding: CrmLead → "O_1*Hospital Project|O_10*450000|C_1*Hansen Yuncken"
 * Decoding: Encoded string → Structured object with _by_table organization
 *
 * This is the core of the self-describing architecture.
 */

import { SCHEMA_DEFINITIONS, ENCODING_CONFIG } from '../constants.js';
import type { CrmLead, DecodedRecord, DecodedField } from '../types.js';
import { isValidRelation, getRelationName as getRelName, getRelationId as getRelId } from '../types.js';

// =============================================================================
// ENCODING
// =============================================================================

/**
 * Encode a CRM lead (opportunity) to prefixed string format.
 *
 * The encoded string contains:
 * - O_* fields: Direct values from crm.lead
 * - C_* fields: Resolved values from partner (res.partner)
 * - S_* fields: Resolved values from stage (crm.stage)
 * - U_* fields: Resolved values from user (res.users)
 * - T_* fields: Resolved values from team (crm.team)
 * - ST_* fields: Resolved values from state (res.country.state)
 * - LR_* fields: Resolved values from lost reason (crm.lost.reason)
 *
 * @param lead CRM lead from Odoo
 * @returns Encoded string
 */
export function encodeOpportunity(lead: CrmLead): string {
  const parts: string[] = [];

  // Helper to add a field
  const addField = (code: string, value: unknown): void => {
    if (value === null || value === undefined || value === false || value === '') {
      return;
    }
    const formatted = formatValue(value, code);
    if (formatted !== null) {
      parts.push(`${code}${ENCODING_CONFIG.VALUE_DELIMITER}${formatted}`);
    }
  };

  // O_ fields (from crm.lead directly)
  addField('O_1', lead.name);
  addField('O_2', lead.id);
  addField('O_10', lead.expected_revenue);
  addField('O_11', lead.probability);
  addField('O_20', cleanDescription(lead.description));
  addField('O_30', lead.create_date);
  addField('O_31', lead.write_date);
  addField('O_32', lead.date_closed);
  addField('O_40', lead.city);
  addField('O_41', lead.x_sector);

  // C_ fields (from res.partner - resolved from partner_id)
  if (isValidRelation(lead.partner_id)) {
    addField('C_1', getRelName(lead.partner_id));
    addField('C_2', getRelId(lead.partner_id));
  }

  // S_ fields (from crm.stage - resolved from stage_id)
  if (isValidRelation(lead.stage_id)) {
    addField('S_1', getRelName(lead.stage_id));
    addField('S_2', getRelId(lead.stage_id));
  }

  // U_ fields (from res.users - resolved from user_id)
  if (isValidRelation(lead.user_id)) {
    addField('U_1', getRelName(lead.user_id));
    addField('U_2', getRelId(lead.user_id));
  }

  // T_ fields (from crm.team - resolved from team_id)
  if (isValidRelation(lead.team_id)) {
    addField('T_1', getRelName(lead.team_id));
    addField('T_2', getRelId(lead.team_id));
  }

  // ST_ fields (from res.country.state - resolved from state_id)
  if (isValidRelation(lead.state_id)) {
    addField('ST_1', getRelName(lead.state_id));
    addField('ST_2', getRelId(lead.state_id));
  }

  // LR_ fields (from crm.lost.reason - resolved from lost_reason_id)
  if (isValidRelation(lead.lost_reason_id)) {
    addField('LR_1', getRelName(lead.lost_reason_id));
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
 * @returns Decoded record with _by_table organization
 */
export function decode(encodedString: string): DecodedRecord {
  const fields: DecodedField[] = [];
  const byTable: Record<string, Record<string, unknown>> = {};

  // Split by field delimiter
  const parts = encodedString.split(ENCODING_CONFIG.FIELD_DELIMITER);

  for (const part of parts) {
    // Find the separator between code and value
    const sepIndex = part.indexOf(ENCODING_CONFIG.VALUE_DELIMITER);
    if (sepIndex === -1) continue;

    const code = part.substring(0, sepIndex);
    const rawValue = part.substring(sepIndex + 1);

    // Look up schema definition
    const schemaDef = SCHEMA_DEFINITIONS[code];
    if (!schemaDef) {
      // Unknown code - still include it
      fields.push({
        code,
        value: unescapeValue(rawValue),
        table: 'unknown',
        field: 'unknown',
        type: 'char',
        parsedValue: unescapeValue(rawValue),
      });
      continue;
    }

    // Parse the value based on type
    const unescaped = unescapeValue(rawValue);
    const parsedValue = parseValue(unescaped, schemaDef.type);

    fields.push({
      code,
      value: unescaped,
      table: schemaDef.table,
      field: schemaDef.field,
      type: schemaDef.type,
      parsedValue,
    });

    // Organize by table
    if (!byTable[schemaDef.table]) {
      byTable[schemaDef.table] = {};
    }
    byTable[schemaDef.table][schemaDef.field] = parsedValue;
  }

  return {
    raw: encodedString,
    fields,
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

  // Partner
  if (isValidRelation(lead.partner_id)) {
    parts.push(`Partner: ${getRelName(lead.partner_id)}`);
  }

  // Stage and status
  if (isValidRelation(lead.stage_id)) {
    parts.push(`Stage: ${getRelName(lead.stage_id)}`);
  }

  // Lost reason (if lost)
  if (isValidRelation(lead.lost_reason_id)) {
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

  // Sector
  if (lead.x_sector && typeof lead.x_sector === 'string') {
    parts.push(`Sector: ${lead.x_sector}`);
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
 * Format value for encoding
 */
function formatValue(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;

  const schemaDef = SCHEMA_DEFINITIONS[code];
  const type = schemaDef?.type || 'char';

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
 */
function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\*/g, '\\*');
}

/**
 * Unescape special characters in value
 */
function unescapeValue(value: string): string {
  return value
    .replace(/\\\*/g, '*')
    .replace(/\\\|/g, '|')
    .replace(/\\\\/g, '\\');
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
