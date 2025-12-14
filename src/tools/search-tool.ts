/**
 * Search Tool
 *
 * Provides ONE tool: semantic_search
 * Searches Odoo schema (17,930 fields) semantically to find:
 * - Where data is stored
 * - Field relationships
 * - Data types and locations
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SemanticSearchSchema, SyncSchema } from '../schemas/index.js';
import type { SemanticSearchInput, SyncInput } from '../schemas/index.js';
import type { SchemaFilter, VectorSearchResult } from '../types.js';
import { embed, isEmbeddingServiceAvailable } from '../services/embedding-service.js';
import { searchSchemaCollection, isVectorClientAvailable, getCollectionInfo } from '../services/vector-client.js';
import { syncSchemaToQdrant, getSyncStatus } from '../services/schema-sync.js';
import { getSchemaStats } from '../services/schema-loader.js';
import { QDRANT_CONFIG } from '../constants.js';

// =============================================================================
// TOOL REGISTRATION
// =============================================================================

/**
 * Register search tools with the MCP server
 */
export function registerSearchTools(server: McpServer): void {
  // =========================================================================
  // SEMANTIC SEARCH TOOL
  // =========================================================================

  server.tool(
    'semantic_search',
    `Search Odoo schema semantically to find fields, understand relationships, and discover where data is stored.

This tool searches across 17,930 Odoo fields from 800+ models using semantic understanding.

**Use Cases:**
- Find where specific data is stored: "Where is customer email?"
- Discover related fields: "Fields related to revenue"
- Understand relationships: "How is salesperson connected to leads?"
- Filter by model: "All date fields in crm.lead"
- Find by type: "many2one relationships in account.move"

**Response includes:**
- Field name and human-readable label
- Field type (char, many2one, one2many, etc.)
- Model name (e.g., crm.lead, res.partner)
- Primary data location (WHERE the data actually lives)
- Model ID and Field ID for direct database access
- Similarity score

**Examples:**
- { "query": "customer email in leads" }
- { "query": "salesperson user", "model_filter": "crm.lead" }
- { "query": "invoice date fields", "type_filter": "date" }
- { "query": "partner relationships", "stored_only": true }`,
    SemanticSearchSchema.shape,
    async (args) => {
      try {
        const input = SemanticSearchSchema.parse(args) as SemanticSearchInput;

        // Check prerequisites
        if (!isVectorClientAvailable()) {
          return {
            content: [{
              type: 'text',
              text: '❌ Vector database not available. Check QDRANT_HOST configuration.',
            }],
          };
        }

        if (!isEmbeddingServiceAvailable()) {
          return {
            content: [{
              type: 'text',
              text: '❌ Embedding service not available. Check VOYAGE_API_KEY configuration.',
            }],
          };
        }

        // Check if collection has data
        const collectionInfo = await getCollectionInfo(QDRANT_CONFIG.COLLECTION);
        if (!collectionInfo.exists || collectionInfo.vectorCount === 0) {
          return {
            content: [{
              type: 'text',
              text: `❌ Schema collection is empty. Run sync first to upload schema data.

**To sync schema:**
Use the sync tool with action: "full_sync"`,
            }],
          };
        }

        // Generate embedding for query
        const queryEmbedding = await embed(input.query, 'query');

        // Build filter
        const filter: SchemaFilter = {};
        if (input.model_filter) filter.model_name = input.model_filter;
        if (input.type_filter) filter.field_type = input.type_filter;
        if (input.stored_only) filter.stored_only = true;

        // Search
        const results = await searchSchemaCollection(queryEmbedding, {
          limit: input.limit,
          minScore: input.min_similarity,
          filter: Object.keys(filter).length > 0 ? filter : undefined,
        });

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No results found for: "${input.query}"

Try:
- Using different keywords
- Lowering min_similarity (current: ${input.min_similarity})
- Removing filters`,
            }],
          };
        }

        // Format results
        const output = formatSearchResults(input.query, results);

        return {
          content: [{ type: 'text', text: output }],
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: 'text',
            text: `❌ Search failed: ${errorMsg}`,
          }],
        };
      }
    }
  );

  // =========================================================================
  // SYNC TOOL (for initial data upload)
  // =========================================================================

  server.tool(
    'sync',
    `Sync Odoo schema to vector database.

**Actions:**
- "status": Check current sync status and collection info
- "full_sync": Upload all 17,930 schema fields to Qdrant

**Note:** Full sync takes several minutes and requires VOYAGE_API_KEY for embeddings.`,
    SyncSchema.shape,
    async (args) => {
      try {
        const input = SyncSchema.parse(args) as SyncInput;

        if (input.action === 'status') {
          // Get status
          const status = await getSyncStatus();
          const stats = getSchemaStats();

          return {
            content: [{
              type: 'text',
              text: `**Schema Sync Status**

**Collection:** ${status.collection}
**Vectors in DB:** ${status.vectorCount.toLocaleString()}
**Last Sync:** ${status.lastSync || 'Never'}

**Schema Data:**
- Total Fields: ${stats.totalFields.toLocaleString()}
- Models: ${stats.models}
- Stored Fields: ${stats.storedCount.toLocaleString()}
- Computed Fields: ${stats.computedCount.toLocaleString()}

**Field Types:**
${Object.entries(stats.fieldTypes)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([type, count]) => `- ${type}: ${count}`)
  .join('\n')}`,
            }],
          };
        }

        if (input.action === 'full_sync') {
          // Check prerequisites
          if (!isVectorClientAvailable()) {
            return {
              content: [{
                type: 'text',
                text: '❌ Vector database not available. Check QDRANT_HOST.',
              }],
            };
          }

          if (!isEmbeddingServiceAvailable()) {
            return {
              content: [{
                type: 'text',
                text: '❌ Embedding service not available. Check VOYAGE_API_KEY.',
              }],
            };
          }

          // Start sync
          const result = await syncSchemaToQdrant(
            input.force_recreate,
            (phase, current, total) => {
              console.error(`[Sync] ${phase}: ${current}/${total}`);
            }
          );

          if (result.success) {
            return {
              content: [{
                type: 'text',
                text: `✅ **Sync Complete**

- Uploaded: ${result.uploaded.toLocaleString()} schemas
- Failed: ${result.failed}
- Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
              }],
            };
          } else {
            return {
              content: [{
                type: 'text',
                text: `⚠️ **Sync Completed with Errors**

- Uploaded: ${result.uploaded.toLocaleString()}
- Failed: ${result.failed}
- Duration: ${(result.durationMs / 1000).toFixed(1)}s

**Errors:**
${result.errors?.slice(0, 5).join('\n') || 'None'}`,
              }],
            };
          }
        }

        return {
          content: [{
            type: 'text',
            text: `Unknown action: ${input.action}`,
          }],
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: 'text',
            text: `❌ Sync failed: ${errorMsg}`,
          }],
        };
      }
    }
  );
}

// =============================================================================
// FORMATTING FUNCTIONS
// =============================================================================

/**
 * Format search results for display
 */
function formatSearchResults(
  query: string,
  results: VectorSearchResult[]
): string {
  const lines: string[] = [];

  lines.push(`**Found ${results.length} results for:** "${query}"\n`);

  for (let i = 0; i < results.length; i++) {
    const { score, payload } = results[i];

    const modelName = payload.model_name;
    const fieldName = payload.field_name;
    const fieldLabel = payload.field_label;
    const fieldType = payload.field_type;
    const primaryLocation = payload.primary_data_location;
    const stored = payload.stored;
    const primaryModelId = payload.primary_model_id;
    const primaryFieldId = payload.primary_field_id;

    lines.push(`---`);
    lines.push(`### ${i + 1}. ${modelName}.${fieldName}`);
    lines.push(`**Label:** ${fieldLabel}`);
    lines.push(`**Type:** ${fieldType}`);

    // Show relationship info for relational fields
    if (fieldType === 'many2one') {
      const relatedModel = primaryLocation.replace('.id', '');
      lines.push(`**Relates to:** ${relatedModel}`);
    } else if (fieldType === 'one2many' || fieldType === 'many2many') {
      lines.push(`**Related location:** ${primaryLocation}`);
    }

    lines.push(`**Primary Data Location:** ${primaryLocation}`);
    lines.push(`**Stored:** ${stored ? 'Yes' : 'No (Computed)'}`);
    lines.push(`**IDs:** Model ${primaryModelId} | Field ${primaryFieldId}`);
    lines.push(`**Score:** ${(score * 100).toFixed(1)}%`);
  }

  // Add helpful tip at the end
  lines.push(`\n---`);
  lines.push(`💡 **Tip:** Use Model ID and Field ID to access data directly via Odoo API.`);

  return lines.join('\n');
}
