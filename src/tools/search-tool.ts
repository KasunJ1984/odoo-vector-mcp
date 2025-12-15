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
import { searchSchemaCollection, scrollSchemaCollection, isVectorClientAvailable, getCollectionInfo } from '../services/vector-client.js';
import { syncSchemaToQdrant, getSyncStatus } from '../services/schema-sync.js';
import { getSchemaStats, getAllModelNames } from '../services/schema-loader.js';
import { QDRANT_CONFIG } from '../constants.js';
import { generateCacheKey, getCached, setCache, getCacheStats } from '../services/cache-service.js';

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
    `Search Odoo schema (17,930 fields across 709 models) with semantic + coordinate understanding.

**COORDINATE SYSTEM (Memory Blocks):**
The schema uses a coordinate encoding: \`4^XX*VALUE\`
- \`4\` = ir.model.fields table (the schema)
- \`58\` = model_id column
- \`26\` = field name column
- \`28\` = model name column

Example: \`4^58*292\` means "model_id = 292" which is account.account
So ALL fields in account.account have model_id = 292

**SEARCH MODES:**
1. \`semantic\` (default): Natural language vector search
   - "Where is customer email?"
   - "Fields related to revenue"

2. \`list\`: Get ALL fields in a model (filter-only, no similarity)
   - "How many columns in account.account?" → Use list mode, count results
   - { "query": "all", "model_filter": "account.account", "search_mode": "list" }

3. \`references_out\`: Find fields that POINT TO other models (outgoing FKs)
   - "What does crm.lead connect to?"
   - Returns: partner_id→res.partner, user_id→res.users

4. \`references_in\`: Find fields that POINT TO a model (incoming FKs)
   - "What references res.partner?"
   - Returns: crm.lead.partner_id, sale.order.partner_id

**IMPORTANT DISTINCTION:**
- "Fields IN account.account" = fields that BELONG to account.account model
- "Fields that REFERENCE account.account" = many2one fields in OTHER models pointing to account.account

**COORDINATE QUERIES:**
- "How many columns in account.account?" → list mode, count results
- "Fields where model_id=267" → list mode with model filter

**MODEL ID REFERENCE (Common models):**
- account.account = 292 | crm.lead = 267 | res.partner = 78 | res.users = 81

**EXAMPLES:**
- Semantic: { "query": "salesperson assignment" }
- List all: { "query": "all", "model_filter": "crm.lead", "search_mode": "list", "limit": 150 }
- Outgoing: { "query": "links", "model_filter": "crm.lead", "search_mode": "references_out" }
- Incoming: { "query": "refs", "model_filter": "res.partner", "search_mode": "references_in" }`,
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

        // Validate model_filter if provided
        if (input.model_filter) {
          const validModels = getAllModelNames();
          if (!validModels.includes(input.model_filter)) {
            // Suggest similar models
            const searchTerm = input.model_filter.toLowerCase();
            const suggestions = validModels
              .filter(m => m.toLowerCase().includes(searchTerm) ||
                          searchTerm.split('.').some(part => m.toLowerCase().includes(part)))
              .slice(0, 5);

            return {
              content: [{
                type: 'text',
                text: `❌ Model "${input.model_filter}" not found in schema.

${suggestions.length > 0 ? `**Did you mean:**\n${suggestions.map(s => `- ${s}`).join('\n')}` : '**Tip:** Use semantic search without model_filter to discover available models.'}

**Total models available:** ${validModels.length}`,
              }],
            };
          }
        }

        // Route based on search_mode
        let results: VectorSearchResult[];

        // MODE: LIST - Get all fields in a model (filter-only, no vector similarity)
        if (input.search_mode === 'list') {
          if (!input.model_filter) {
            return {
              content: [{
                type: 'text',
                text: `❌ **list** mode requires model_filter parameter.

**Example:**
{ "query": "all", "model_filter": "crm.lead", "search_mode": "list" }`,
              }],
            };
          }

          const filter: SchemaFilter = { model_name: input.model_filter };
          if (input.type_filter) filter.field_type = input.type_filter;
          if (input.stored_only) filter.stored_only = true;

          results = await scrollSchemaCollection({
            filter,
            limit: input.limit,
          });

          const output = formatListResults(input.model_filter, results, input.type_filter);
          return { content: [{ type: 'text', text: output }] };
        }

        // MODE: REFERENCES_OUT - Find many2one/one2many/many2many fields IN target model
        if (input.search_mode === 'references_out') {
          if (!input.model_filter) {
            return {
              content: [{
                type: 'text',
                text: `❌ **references_out** mode requires model_filter parameter.

**Example:**
{ "query": "out", "model_filter": "crm.lead", "search_mode": "references_out" }`,
              }],
            };
          }

          const filter: SchemaFilter = {
            model_name: input.model_filter,
            field_type: ['many2one', 'one2many', 'many2many'],
          };

          results = await scrollSchemaCollection({
            filter,
            limit: input.limit,
          });

          const output = formatReferencesOutResults(input.model_filter, results);
          return { content: [{ type: 'text', text: output }] };
        }

        // MODE: REFERENCES_IN - Find fields in OTHER models that point TO target model
        if (input.search_mode === 'references_in') {
          if (!input.model_filter) {
            return {
              content: [{
                type: 'text',
                text: `❌ **references_in** mode requires model_filter parameter.

**Example:**
{ "query": "in", "model_filter": "res.partner", "search_mode": "references_in" }`,
              }],
            };
          }

          // Filter where primary_data_location starts with target model
          // e.g., primary_data_location = "res.partner.id" for many2one to res.partner
          const filter: SchemaFilter = {
            primary_data_location_prefix: input.model_filter,
            field_type: 'many2one', // Only many2one stores FK to other model
          };

          results = await scrollSchemaCollection({
            filter,
            limit: input.limit,
          });

          const output = formatReferencesInResults(input.model_filter, results);
          return { content: [{ type: 'text', text: output }] };
        }

        // MODE: SEMANTIC (default) - Vector similarity search

        // Check cache first (saves embedding API call + vector search)
        const cacheKey = generateCacheKey(
          input.query,
          'semantic',
          input.model_filter,
          input.type_filter ? [input.type_filter] : undefined,
          input.limit,
          input.min_similarity
        );

        const cachedResults = getCached(cacheKey);
        if (cachedResults) {
          // Cache hit - return cached results directly
          const output = formatSearchResults(input.query, cachedResults);
          return {
            content: [{ type: 'text', text: output + '\n\n*📦 Results from cache*' }],
          };
        }

        // Cache miss - proceed with embedding and search
        if (!isEmbeddingServiceAvailable()) {
          return {
            content: [{
              type: 'text',
              text: '❌ Embedding service not available. Check VOYAGE_API_KEY configuration.',
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
        results = await searchSchemaCollection(queryEmbedding, {
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
- Removing filters
- Using **list** mode to see all fields in a model`,
            }],
          };
        }

        // Store in cache for future queries
        setCache(cacheKey, results);

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
          const cacheStats = getCacheStats();

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

**Query Cache:**
- Enabled: ${cacheStats.enabled ? 'Yes' : 'No'}
- Entries: ${cacheStats.size}/${cacheStats.maxSize}
- Hit Rate: ${cacheStats.hitRate} (${cacheStats.hits} hits, ${cacheStats.misses} misses)

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
 * Format semantic search results for display
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

/**
 * Format list mode results (all fields in a model)
 */
function formatListResults(
  modelName: string,
  results: VectorSearchResult[],
  typeFilter?: string
): string {
  const lines: string[] = [];

  // Summary header
  lines.push(`## Fields in ${modelName}`);
  lines.push(`**Total fields:** ${results.length}${typeFilter ? ` (filtered by type: ${typeFilter})` : ''}\n`);

  // Group by field type for better overview
  const byType: Record<string, VectorSearchResult[]> = {};
  for (const r of results) {
    const type = r.payload.field_type;
    if (!byType[type]) byType[type] = [];
    byType[type].push(r);
  }

  // Show type counts
  lines.push(`**By Type:**`);
  for (const [type, fields] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`- ${type}: ${fields.length}`);
  }
  lines.push('');

  // List fields organized by type
  for (const [type, fields] of Object.entries(byType).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### ${type} (${fields.length})`);

    for (const { payload } of fields) {
      const storedMark = payload.stored ? '' : ' *(computed)*';
      lines.push(`- **${payload.field_name}** - ${payload.field_label}${storedMark}`);

      // Show target for relational fields
      if (type === 'many2one') {
        const target = payload.primary_data_location.replace('.id', '');
        lines.push(`  → ${target}`);
      }
    }
    lines.push('');
  }

  // Model coordinate info
  if (results.length > 0) {
    const modelId = results[0].payload.model_id;
    lines.push(`---`);
    lines.push(`📍 **Model coordinate:** 4^58*${modelId} (model_id=${modelId})`);
  }

  return lines.join('\n');
}

/**
 * Format references_out results (fields that POINT TO other models)
 */
function formatReferencesOutResults(
  modelName: string,
  results: VectorSearchResult[]
): string {
  const lines: string[] = [];

  lines.push(`## Outgoing References from ${modelName}`);
  lines.push(`**Total relational fields:** ${results.length}\n`);

  // Group by relationship type
  const byType: Record<string, VectorSearchResult[]> = {};
  for (const r of results) {
    const type = r.payload.field_type;
    if (!byType[type]) byType[type] = [];
    byType[type].push(r);
  }

  // Many2one = FK to another model
  if (byType['many2one']?.length) {
    lines.push(`### Many-to-One (Foreign Keys) - ${byType['many2one'].length}`);
    lines.push(`*Fields that link to ONE record in another model*\n`);

    for (const { payload } of byType['many2one']) {
      const targetModel = payload.primary_data_location.replace('.id', '');
      lines.push(`- **${payload.field_name}** (${payload.field_label})`);
      lines.push(`  → Links to: **${targetModel}**`);
    }
    lines.push('');
  }

  // One2many = reverse relationship
  if (byType['one2many']?.length) {
    lines.push(`### One-to-Many - ${byType['one2many'].length}`);
    lines.push(`*Fields that show MANY records from another model*\n`);

    for (const { payload } of byType['one2many']) {
      lines.push(`- **${payload.field_name}** (${payload.field_label})`);
      lines.push(`  → Shows records from: ${payload.primary_data_location}`);
    }
    lines.push('');
  }

  // Many2many = bidirectional relationship
  if (byType['many2many']?.length) {
    lines.push(`### Many-to-Many - ${byType['many2many'].length}`);
    lines.push(`*Fields with bidirectional many-to-many relationship*\n`);

    for (const { payload } of byType['many2many']) {
      lines.push(`- **${payload.field_name}** (${payload.field_label})`);
      lines.push(`  → Related: ${payload.primary_data_location}`);
    }
    lines.push('');
  }

  if (results.length === 0) {
    lines.push(`*No relational fields found in ${modelName}*`);
  }

  return lines.join('\n');
}

/**
 * Format references_in results (fields in OTHER models that point TO target)
 */
function formatReferencesInResults(
  targetModel: string,
  results: VectorSearchResult[]
): string {
  const lines: string[] = [];

  lines.push(`## Incoming References to ${targetModel}`);
  lines.push(`**Models that link TO ${targetModel}:** ${results.length} fields\n`);

  if (results.length === 0) {
    lines.push(`*No incoming references found to ${targetModel}*`);
    lines.push(`\n**Tip:** This model may not be referenced by other models, or may use a different naming pattern.`);
    return lines.join('\n');
  }

  // Group by source model
  const byModel: Record<string, VectorSearchResult[]> = {};
  for (const r of results) {
    const sourceModel = r.payload.model_name;
    if (!byModel[sourceModel]) byModel[sourceModel] = [];
    byModel[sourceModel].push(r);
  }

  lines.push(`**Referenced from ${Object.keys(byModel).length} models:**\n`);

  for (const [sourceModel, fields] of Object.entries(byModel).sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${sourceModel} (${fields.length} field${fields.length > 1 ? 's' : ''})`);

    for (const { payload } of fields) {
      lines.push(`- **${payload.field_name}** (${payload.field_label})`);
      lines.push(`  → many2one FK to ${targetModel}`);
    }
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`💡 **Use case:** These are the models that have a direct relationship to ${targetModel}.`);
  lines.push(`You can use these foreign keys to join data across models.`);

  return lines.join('\n');
}
