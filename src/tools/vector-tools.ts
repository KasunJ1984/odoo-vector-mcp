/**
 * MCP Vector Tools
 *
 * Registers 4 tools for the self-describing vector database:
 * 1. vector_discover_schema - Search schema by meaning (AI Schema Discovery)
 * 2. vector_semantic_search - Natural language search
 * 3. vector_decode - Decode encoded strings
 * 4. vector_sync - Sync data from Odoo
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
Use this tool to discover what fields are available and what schema codes (O_1, C_1, etc.) mean.

The prefix indicates the SOURCE TABLE:
- O_  = crm.lead (Opportunity)
- C_  = res.partner (Contact)
- S_  = crm.stage (Stage)
- U_  = res.users (User/Salesperson)
- T_  = crm.team (Team)
- ST_ = res.country.state (State)
- LR_ = crm.lost.reason (Lost Reason)

Examples:
- "find fields about revenue" → O_10 (expected_revenue)
- "contact information" → C_10 (email), C_11 (phone)
- "pipeline stage" → S_1 (stage name)
- "who is responsible" → U_1 (salesperson name)`,
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
          lines.push(`### ${result.code}`);
          lines.push(`- **Table**: ${result.table}`);
          lines.push(`- **Field**: ${result.field}`);
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
- Key metadata (revenue, stage, etc.)`,
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

          lines.push(`### ${i + 1}. ${getDecodedName(p.encoded_string)} (ID: ${p.odoo_id})`);
          lines.push(`- **Similarity**: ${(result.score * 100).toFixed(1)}%`);

          if (p.expected_revenue) {
            lines.push(`- **Revenue**: ${formatCurrency(p.expected_revenue)}`);
          }
          if (p.sector) {
            lines.push(`- **Sector**: ${p.sector}`);
          }
          if (p.city || p.state_name) {
            lines.push(`- **Location**: ${[p.city, p.state_name].filter(Boolean).join(', ')}`);
          }
          if (p.is_lost) {
            lines.push(`- **Status**: Lost`);
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

Encoded strings use source-table-prefixed format:
"O_1*Hospital Project|O_10*450000|C_1*Hansen Yuncken"

The prefix indicates which Odoo table the value came from:
- O_  = crm.lead
- C_  = res.partner
- S_  = crm.stage
- U_  = res.users
- etc.

Returns structured data organized by source table.`,
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

        // Fields by table
        lines.push('### Fields by Source Table');
        lines.push('');

        for (const [table, fields] of Object.entries(decoded._by_table)) {
          lines.push(`#### ${table}`);
          for (const [field, value] of Object.entries(fields)) {
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
          lines.push(`| ${field.code} | ${field.table} | ${field.field} | ${truncate(String(field.parsedValue), 40)} |`);
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

Use "status" first to check current state before running a full sync.`,
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
 * Extract name from encoded string (O_1 field)
 */
function getDecodedName(encodedString: string): string {
  const match = encodedString.match(/O_1\*([^|]+)/);
  return match ? match[1] : 'Unknown';
}
