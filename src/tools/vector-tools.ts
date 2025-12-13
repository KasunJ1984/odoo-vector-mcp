/**
 * MCP Vector Tools
 *
 * Registers 4 tools for the self-describing vector database:
 * 1. vector_discover_schema - Search schema by meaning (AI Schema Discovery)
 * 2. vector_semantic_search - Natural language search
 * 3. vector_decode - Decode encoded strings
 * 4. vector_sync - Sync data from Odoo
 *
 * NEW FORMAT: {TABLE_NUMBER}^{COLUMN_NUMBER}*{VALUE}
 * Example: 1^10*450000|2^1*Hansen|3^1*Tender RFQ
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DiscoverSchemaSchema,
  SemanticSearchSchema,
  DecodeSchema,
  SyncSchema,
  type DiscoverSchemaInput,
  type SemanticSearchInput,
  type DecodeInput,
  type SyncInput,
} from '../schemas/index.js';
import { searchSchema, getSchemaStatus, getAllSchema } from '../services/schema-service.js';
import { decode } from '../services/encoder-service.js';
import { embed } from '../services/embedding-service.js';
import { searchDataCollection } from '../services/vector-client.js';
import { fullSync, syncRecord, getSyncStatus } from '../services/sync-service.js';
import { TABLE_DISPLAY_NAMES } from '../constants.js';
import type { VectorFilter } from '../types.js';

/**
 * Register all vector tools with the MCP server
 */
export function registerVectorTools(server: McpServer): void {
  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL 1: vector_discover_schema (THE KEY INNOVATION)
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    'vector_discover_schema',
    `Search the schema definitions by semantic meaning.

This is the KEY INNOVATION of the self-describing vector database.
Use this tool to discover what fields are available and what schema codes mean.

Schema codes use NUMERIC format: {TABLE}^{COLUMN}
The TABLE number indicates the SOURCE TABLE:
- 1  = crm.lead (Opportunity)
- 2  = res.partner (Contact)
- 3  = crm.stage (Stage)
- 4  = res.users (User/Salesperson)
- 5  = crm.team (Team)
- 6  = res.country.state (State)
- 7  = crm.lost.reason (Lost Reason)
- 8  = x_specification (Specification)
- 9  = x_lead_source (Lead Source)
- 10 = res.partner (Architect)

Examples:
- "find fields about revenue" → 1^10 (expected_revenue)
- "contact information" → 2^10 (email), 2^11 (phone)
- "pipeline stage" → 3^1 (stage name)
- "who is responsible" → 4^1 (salesperson name)
- "specification type" → 8^1 (specification name)`,
    DiscoverSchemaSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      try {
        const input = DiscoverSchemaSchema.parse(args) as DiscoverSchemaInput;

        const results = await searchSchema(input.query, {
          limit: input.limit,
          tableFilter: input.table_filter,
        });

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No schema fields found matching "${input.query}".\n\nTry broader terms like "money", "contact", "date", or "location".`
            }]
          };
        }

        // Format results
        const lines: string[] = [
          `## Schema Discovery: "${input.query}"`,
          '',
          `Found ${results.length} matching field(s):`,
          '',
        ];

        for (const result of results) {
          const tableName = TABLE_DISPLAY_NAMES[result.table_number] || result.table;
          lines.push(`### ${result.code} (${tableName})`);
          lines.push(`- **Table**: ${result.table} (Table ${result.table_number})`);
          lines.push(`- **Field**: ${result.field} (Column ${result.column_number})`);
          lines.push(`- **Type**: ${result.type}`);
          lines.push(`- **Description**: ${result.semantic}`);
          lines.push(`- **Score**: ${(result.score * 100).toFixed(1)}%`);
          lines.push('');
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }]
        };

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error discovering schema: ${errorMsg}` }]
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL 2: vector_semantic_search
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    'vector_semantic_search',
    `Semantic search across CRM opportunities using natural language.

Returns opportunities with their encoded field data (use vector_decode to interpret).

Examples:
- "hospital projects in Victoria"
- "large commercial deals we lost to competitors"
- "education sector opportunities over $100k"
- "opportunities managed by John Smith"

Results include:
- Opportunity name and ID
- Similarity score
- Encoded string (decode with vector_decode)
- Key metadata (revenue, stage, contact, specification, etc.)`,
    SemanticSearchSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      try {
        const input = SemanticSearchSchema.parse(args) as SemanticSearchInput;

        // Generate query embedding
        const queryVector = await embed(input.query, 'query');

        // Build filter
        const filter: VectorFilter = {};
        if (input.stage_id) filter.stage_id = input.stage_id;
        if (input.user_id) filter.user_id = input.user_id;
        if (input.is_won !== undefined) filter.is_won = input.is_won;
        if (input.is_lost !== undefined) filter.is_lost = input.is_lost;
        if (input.sector) filter.sector = input.sector;
        if (input.min_revenue || input.max_revenue) {
          filter.expected_revenue = {};
          if (input.min_revenue) filter.expected_revenue.$gte = input.min_revenue;
          if (input.max_revenue) filter.expected_revenue.$lte = input.max_revenue;
        }

        // Search
        const results = await searchDataCollection(queryVector, {
          limit: input.limit,
          minScore: input.min_similarity,
          filter: Object.keys(filter).length > 0 ? filter : undefined,
        });

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No opportunities found matching "${input.query}".\n\nTry different search terms or adjust filters.`
            }]
          };
        }

        // Format results
        const lines: string[] = [
          `## Semantic Search: "${input.query}"`,
          '',
          `Found ${results.length} matching opportunity(ies):`,
          '',
        ];

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const p = result.payload;

          // Use semantic field if available, otherwise decode
          const opportunityName = p.opportunity_name || getDecodedName(p.encoded_string);
          lines.push(`### ${i + 1}. ${opportunityName} (ID: ${p.odoo_id})`);
          lines.push(`- **Similarity**: ${(result.score * 100).toFixed(1)}%`);

          if (p.expected_revenue) {
            lines.push(`- **Revenue**: ${formatCurrency(p.expected_revenue)}`);
          }
          if (p.contact_name) {
            lines.push(`- **Contact**: ${p.contact_name}`);
          }
          if (p.stage_name) {
            lines.push(`- **Stage**: ${p.stage_name}`);
          }
          if (p.sector) {
            lines.push(`- **Sector**: ${p.sector}`);
          }
          if (p.city || p.state_name) {
            lines.push(`- **Location**: ${[p.city, p.state_name].filter(Boolean).join(', ')}`);
          }
          if (p.user_name) {
            lines.push(`- **Salesperson**: ${p.user_name}`);
          }
          if (p.specification_name) {
            lines.push(`- **Specification**: ${p.specification_name}`);
          }
          if (p.lead_source_name) {
            lines.push(`- **Lead Source**: ${p.lead_source_name}`);
          }
          if (p.architect_name) {
            lines.push(`- **Architect**: ${p.architect_name}`);
          }
          if (p.is_won) {
            lines.push(`- **Status**: Won`);
          } else if (p.is_lost) {
            lines.push(`- **Status**: Lost${p.lost_reason_name ? ` (${p.lost_reason_name})` : ''}`);
          }

          lines.push(`- **Encoded**: \`${truncate(p.encoded_string, 100)}\``);
          lines.push('');
        }

        lines.push('---');
        lines.push('*Use `vector_decode` to fully decode any encoded string.*');

        return {
          content: [{ type: 'text', text: lines.join('\n') }]
        };

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error searching: ${errorMsg}` }]
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL 3: vector_decode
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    'vector_decode',
    `Decode an encoded string from vector search results.

Encoded strings use numeric table-prefixed format:
"1^1*Hospital Project|1^10*450000|2^1*Hansen Yuncken"

The TABLE number indicates which Odoo table the value came from:
- 1  = crm.lead (Opportunity)
- 2  = res.partner (Contact)
- 3  = crm.stage (Stage)
- 4  = res.users (User)
- 5  = crm.team (Team)
- 6  = res.country.state (State)
- 7  = crm.lost.reason (Lost Reason)
- 8  = x_specification (Specification)
- 9  = x_lead_source (Lead Source)
- 10 = res.partner (Architect)

Returns structured data organized by source table number.`,
    DecodeSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      try {
        const input = DecodeSchema.parse(args) as DecodeInput;

        const decoded = decode(input.encoded_string);

        // Format results
        const lines: string[] = [
          '## Decoded Record',
          '',
        ];

        if (input.include_raw) {
          lines.push('### Raw Encoded String');
          lines.push('```');
          lines.push(decoded.raw);
          lines.push('```');
          lines.push('');
        }

        // Schema codes found
        lines.push('### Schema Codes Found');
        lines.push(`\`${decoded._schema_codes.join(', ')}\``);
        lines.push('');

        // Fields by table NUMBER
        lines.push('### Fields by Source Table');
        lines.push('');

        for (const [tableNumberStr, fields] of Object.entries(decoded._by_table)) {
          const tableNumber = parseInt(tableNumberStr, 10);
          const tableName = TABLE_DISPLAY_NAMES[tableNumber] || `Table ${tableNumber}`;
          lines.push(`#### Table ${tableNumber}: ${tableName}`);
          for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
            const displayValue = typeof value === 'number' && field.includes('revenue')
              ? formatCurrency(value as number)
              : String(value);
            lines.push(`- **${field}**: ${displayValue}`);
          }
          lines.push('');
        }

        // All fields in order
        lines.push('### All Fields (in encoded order)');
        lines.push('');
        lines.push('| Code | Table | Field | Value |');
        lines.push('|------|-------|-------|-------|');

        for (const field of decoded.fields) {
          const tableName = TABLE_DISPLAY_NAMES[field.table_number] || field.table;
          lines.push(`| ${field.code} | ${tableName} | ${field.field} | ${truncate(String(field.parsedValue), 40)} |`);
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }]
        };

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error decoding: ${errorMsg}` }]
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL 4: vector_sync
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    'vector_sync',
    `Synchronize CRM data from Odoo to the vector database.

Actions:
- **status**: Check sync state (last sync time, record count, running status)
- **full_sync**: Rebuild the entire vector index from Odoo (may take several minutes)
- **sync_record**: Sync a specific opportunity by ID

Use "status" first to check current state before running a full sync.

IMPORTANT: After deploying code changes to the encoding format, you should:
1. Delete the Qdrant collections manually
2. Redeploy the server (which recreates collections)
3. Run full_sync to populate with new format`,
    SyncSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      try {
        const input = SyncSchema.parse(args) as SyncInput;

        switch (input.action) {
          case 'status': {
            const status = await getSyncStatus();
            const schemaStatus = await getSchemaStatus();

            const lines = [
              '## Vector Database Status',
              '',
              '### Data Collection (crm_data)',
              `- **Total Records**: ${status.totalRecords}`,
              `- **Last Sync**: ${status.lastSync || 'Never'}`,
              `- **Sync Running**: ${status.isRunning ? 'Yes' : 'No'}`,
              '',
              '### Schema Collection (crm_schema)',
              `- **Exists**: ${schemaStatus.exists ? 'Yes' : 'No'}`,
              `- **Vectors**: ${schemaStatus.vectorCount}`,
              `- **Definitions**: ${schemaStatus.definitionCount}`,
              '',
              '### Encoding Format',
              '- **Pattern**: `{TABLE}^{COLUMN}*{VALUE}`',
              '- **Tables**: 10 (Opportunity, Contact, Stage, User, Team, State, LostReason, Specification, LeadSource, Architect)',
            ];

            return {
              content: [{ type: 'text', text: lines.join('\n') }]
            };
          }

          case 'full_sync': {
            const result = await fullSync((progress) => {
              console.error(`[Sync] ${progress.phase}: ${progress.current}/${progress.total} - ${progress.message || ''}`);
            });

            const lines = [
              '## Full Sync Result',
              '',
              `- **Success**: ${result.success ? 'Yes' : 'No'}`,
              `- **Records Synced**: ${result.recordsSynced}`,
              `- **Records Failed**: ${result.recordsFailed}`,
              `- **Duration**: ${(result.durationMs / 1000).toFixed(1)} seconds`,
            ];

            if (result.errors && result.errors.length > 0) {
              lines.push('', '### Errors');
              for (const err of result.errors) {
                lines.push(`- ${err}`);
              }
            }

            return {
              content: [{ type: 'text', text: lines.join('\n') }]
            };
          }

          case 'sync_record': {
            if (!input.lead_id) {
              return {
                content: [{ type: 'text', text: 'Error: lead_id is required for sync_record action' }]
              };
            }

            const result = await syncRecord(input.lead_id);

            const lines = [
              `## Sync Record ${input.lead_id}`,
              '',
              `- **Success**: ${result.success ? 'Yes' : 'No'}`,
              `- **Duration**: ${result.durationMs}ms`,
            ];

            if (result.errors && result.errors.length > 0) {
              lines.push('', '### Errors');
              for (const err of result.errors) {
                lines.push(`- ${err}`);
              }
            }

            return {
              content: [{ type: 'text', text: lines.join('\n') }]
            };
          }

          default:
            return {
              content: [{ type: 'text', text: `Unknown action: ${input.action}` }]
            };
        }

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error with sync: ${errorMsg}` }]
        };
      }
    }
  );

  console.error('[Tools] Registered 4 vector tools');
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Format currency (AUD)
 */
function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Truncate string with ellipsis
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Extract name from encoded string (1^1 field = opportunity name)
 */
function getDecodedName(encodedString: string): string {
  // New format: 1^1*Name
  const match = encodedString.match(/1\^1\*([^|]+)/);
  return match ? match[1] : 'Unknown';
}
