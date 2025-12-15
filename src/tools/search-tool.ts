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
import type { SchemaFilter, VectorSearchResult, SchemaPayload, DataPayload } from '../types.js';
import { isDataPayload } from '../types.js';
import { embed, isEmbeddingServiceAvailable } from '../services/embedding-service.js';
import { searchSchemaCollection, scrollSchemaCollection, isVectorClientAvailable, getCollectionInfo } from '../services/vector-client.js';
import { syncSchemaToQdrant, getSyncStatus, incrementalSyncSchema } from '../services/schema-sync.js';
import { getSchemaStats, getAllModelNames } from '../services/schema-loader.js';
import { QDRANT_CONFIG, KEY_FIELDS_CONFIG } from '../constants.js';
import { generateCacheKey, getCached, setCache, getCacheStats } from '../services/cache-service.js';
import { decodeRecord, decodeRecordToText } from '../services/data-transformer.js';
import {
  trackFieldUsageBatch,
  recordTrainingPair,
  getAdaptiveKeyFields,
  getAnalyticsSummary,
  getTrainingStats,
} from '../services/analytics-service.js';

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
    `Search Odoo schema AND data with semantic understanding.

**UNIFIED SEARCH - Schema + Data in One Collection:**
- Schema: 17,930 field definitions (WHERE data lives)
- Data: CRM records like crm.lead (WHAT the actual values are)

**POINT TYPES:**
- \`schema\` (default): Search field definitions only
- \`data\`: Search actual CRM records
- \`all\`: Search both schema and data together

**DATA ENCODING FORMAT:**
Data uses coordinate encoding: \`[model_id]^[field_id]*VALUE\`
Example crm.lead record: \`344^6327*12345|344^6299*450000|78^956*201\`
- \`344^6327*12345\` = crm.lead.id = 12345
- \`78^956*201\` = partner_id → res.partner id=201 (FK uses TARGET model prefix!)

**SEARCH MODES:**
1. \`semantic\` (default): Natural language vector search
   - Schema: "Where is customer email?" → finds field definitions
   - Data: "Hospital projects in Victoria" → finds CRM records

2. \`list\`: Get ALL fields in a model (schema only)
   - { "query": "all", "model_filter": "crm.lead", "search_mode": "list" }

3. \`references_out\`: Find outgoing FK fields (schema only)
4. \`references_in\`: Find incoming FK fields (schema only)

**EXAMPLES:**
- Search schema: { "query": "revenue fields", "point_type": "schema" }
- Search data: { "query": "hospital projects Victoria", "point_type": "data" }
- Search both: { "query": "Hansen Yuncken", "point_type": "all" }
- List fields: { "query": "all", "model_filter": "crm.lead", "search_mode": "list" }`,
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
          input.min_similarity,
          input.point_type  // Include point_type in cache key
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
        if (input.point_type) filter.point_type = input.point_type;

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
- "full_sync": Upload ALL 17,930 schema fields (slow, ~60s)
- "incremental_sync": Only sync changed fields (fast, preserves cache if no changes)

**Recommended:** Use incremental_sync for regular updates. It:
- Detects added/modified/deleted fields
- Only embeds what changed (saves API costs)
- Preserves query cache if no changes (instant return)

**Note:** Requires VOYAGE_API_KEY for embeddings.`,
    SyncSchema.shape,
    async (args) => {
      try {
        const input = SyncSchema.parse(args) as SyncInput;

        if (input.action === 'status') {
          // Get status
          const status = await getSyncStatus();
          const stats = getSchemaStats();
          const cacheStats = getCacheStats();
          const analytics = getAnalyticsSummary();
          const trainingStats = getTrainingStats();

          // Build analytics section
          let analyticsSection = `**NEXUS Analytics (Self-Improving):**
- Total Decodes: ${analytics.total_decodes.toLocaleString()}
- Total Searches: ${analytics.total_searches.toLocaleString()}
- Data Age: ${analytics.data_age_hours} hours`;

          if (analytics.top_fields.length > 0) {
            analyticsSection += `\n\n**Top Decoded Fields:**\n${analytics.top_fields
              .slice(0, 5)
              .map(f => `- ${f.field}: ${f.count}`)
              .join('\n')}`;
          }

          if (analytics.suggested_promotions.length > 0) {
            analyticsSection += `\n\n**Suggested Key Field Promotions:**\n${analytics.suggested_promotions
              .map(s => `- ${s}`)
              .join('\n')}`;
          }

          // Build training data section
          let trainingSection = `**Training Data (Phase 2):**
- Total Pairs: ${trainingStats.total_pairs.toLocaleString()}`;

          if (Object.keys(trainingStats.by_model).length > 0) {
            trainingSection += `\n- By Model: ${Object.entries(trainingStats.by_model)
              .map(([model, count]) => `${model}: ${count}`)
              .join(', ')}`;
          }

          if (trainingStats.oldest && trainingStats.newest) {
            trainingSection += `\n- Range: ${new Date(trainingStats.oldest).toLocaleDateString()} - ${new Date(trainingStats.newest).toLocaleDateString()}`;
          }

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

${analyticsSection}

${trainingSection}

**Field Types (Top 10):**
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
                text: `✅ **Full Sync Complete**

- Uploaded: ${result.uploaded.toLocaleString()} schemas
- Failed: ${result.failed}
- Duration: ${(result.durationMs / 1000).toFixed(1)}s
- Cache: Cleared`,
              }],
            };
          } else {
            return {
              content: [{
                type: 'text',
                text: `⚠️ **Full Sync Completed with Errors**

- Uploaded: ${result.uploaded.toLocaleString()}
- Failed: ${result.failed}
- Duration: ${(result.durationMs / 1000).toFixed(1)}s

**Errors:**
${result.errors?.slice(0, 5).join('\n') || 'None'}`,
              }],
            };
          }
        }

        // =====================================================================
        // INCREMENTAL SYNC
        // =====================================================================
        if (input.action === 'incremental_sync') {
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

          // Run incremental sync
          const result = await incrementalSyncSchema(
            (phase, current, total) => {
              console.error(`[IncrementalSync] ${phase}: ${current}/${total}`);
            }
          );

          if (result.success) {
            const totalChanges = result.added + result.modified + result.deleted;

            // No changes case - fast path
            if (totalChanges === 0) {
              return {
                content: [{
                  type: 'text',
                  text: `✅ **Incremental Sync: No Changes**

- Schema unchanged: ${result.unchanged.toLocaleString()} fields
- Duration: ${(result.durationMs / 1000).toFixed(1)}s
- Cache: Preserved ✓

*Schema is up to date. Query cache preserved for fast searches.*`,
                }],
              };
            }

            // Changes detected
            return {
              content: [{
                type: 'text',
                text: `✅ **Incremental Sync Complete**

**Changes Processed:**
- Added: ${result.added}
- Modified: ${result.modified}
- Deleted: ${result.deleted}
- Unchanged: ${result.unchanged.toLocaleString()}

- Duration: ${(result.durationMs / 1000).toFixed(1)}s
- Cache: ${result.cacheCleared ? 'Cleared (changes detected)' : 'Preserved'}`,
              }],
            };
          } else {
            return {
              content: [{
                type: 'text',
                text: `⚠️ **Incremental Sync Failed**

- Added: ${result.added}
- Modified: ${result.modified}
- Deleted: ${result.deleted}
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
 * Format semantic search results for display (handles both schema and data)
 */
function formatSearchResults(
  query: string,
  results: VectorSearchResult[]
): string {
  const lines: string[] = [];

  // Count schema vs data results
  const schemaResults = results.filter(r => !isDataPayload(r.payload));
  const dataResults = results.filter(r => isDataPayload(r.payload));

  lines.push(`**Found ${results.length} results for:** "${query}"`);
  if (schemaResults.length > 0 && dataResults.length > 0) {
    lines.push(`(${schemaResults.length} schema, ${dataResults.length} data)`);
  }
  lines.push('');

  for (let i = 0; i < results.length; i++) {
    const { score, payload } = results[i];

    lines.push(`---`);

    if (isDataPayload(payload)) {
      // Format DATA result with NEXUS decoding
      const dataPayload = payload as DataPayload;
      lines.push(`### ${i + 1}. [DATA] ${dataPayload.model_name} #${dataPayload.record_id}`);
      lines.push(`**Score:** ${(score * 100).toFixed(1)}%`);
      lines.push('');

      // Get adaptive key fields (config + analytics-discovered)
      const keyFields = getAdaptiveKeyFields(dataPayload.model_name);

      // Decode the record using NEXUS decoder
      const decoded = decodeRecord(dataPayload.encoded_string, keyFields);

      if (decoded.length > 0) {
        lines.push('**Key Fields:**');
        for (const field of decoded) {
          lines.push(`- **${field.field_label}:** ${field.display_value}`);
        }

        // Track field usage for analytics (async, fire-and-forget)
        setImmediate(() => {
          const fieldNames = decoded.map(f => f.field_name);
          trackFieldUsageBatch(dataPayload.model_name, fieldNames, 'decode');
        });

        // Record training pair for Phase 2
        const decodedText = decodeRecordToText(dataPayload.encoded_string, keyFields);
        setImmediate(() => {
          recordTrainingPair(dataPayload.encoded_string, decodedText, dataPayload.model_name);
        });
      } else {
        lines.push('*No decodable key fields found*');
      }

      // Collapsible raw encoded data
      lines.push('');
      lines.push('<details>');
      lines.push('<summary>Raw encoded data (click to expand)</summary>');
      lines.push('');
      lines.push('```');
      lines.push(dataPayload.encoded_string);
      lines.push('```');
      lines.push('</details>');
    } else {
      // Format SCHEMA result
      const schemaPayload = payload as SchemaPayload;
      lines.push(`### ${i + 1}. [SCHEMA] ${schemaPayload.model_name}.${schemaPayload.field_name}`);
      lines.push(`**Label:** ${schemaPayload.field_label}`);
      lines.push(`**Type:** ${schemaPayload.field_type}`);

      // Show relationship info for relational fields
      if (schemaPayload.field_type === 'many2one') {
        const relatedModel = schemaPayload.primary_data_location.replace('.id', '');
        lines.push(`**Relates to:** ${relatedModel}`);
      } else if (schemaPayload.field_type === 'one2many' || schemaPayload.field_type === 'many2many') {
        lines.push(`**Related location:** ${schemaPayload.primary_data_location}`);
      }

      lines.push(`**Primary Data Location:** ${schemaPayload.primary_data_location}`);
      lines.push(`**Stored:** ${schemaPayload.stored ? 'Yes' : 'No (Computed)'}`);
      lines.push(`**IDs:** Model ${schemaPayload.primary_model_id} | Field ${schemaPayload.primary_field_id}`);
      lines.push(`**Score:** ${(score * 100).toFixed(1)}%`);
    }
  }

  // Add helpful tip at the end
  lines.push(`\n---`);
  if (dataResults.length > 0) {
    lines.push(`💡 **NEXUS Decode:** Key fields automatically decoded from coordinate encoding.`);
    lines.push(`   Expand "Raw encoded data" for full NEXUS coordinates.`);
  } else {
    lines.push(`💡 **Tip:** Use Model ID and Field ID to access data directly via Odoo API.`);
  }

  return lines.join('\n');
}

/**
 * Format list mode results (all fields in a model)
 * Note: List mode only works with schema, so we cast payloads to SchemaPayload
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
    const payload = r.payload as SchemaPayload;
    const type = payload.field_type;
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

    for (const { payload: p } of fields) {
      const payload = p as SchemaPayload;
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
    const payload = results[0].payload as SchemaPayload;
    lines.push(`---`);
    lines.push(`📍 **Model coordinate:** 4^58*${payload.model_id} (model_id=${payload.model_id})`);
  }

  return lines.join('\n');
}

/**
 * Format references_out results (fields that POINT TO other models)
 * Note: References mode only works with schema, so we cast payloads to SchemaPayload
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
    const payload = r.payload as SchemaPayload;
    const type = payload.field_type;
    if (!byType[type]) byType[type] = [];
    byType[type].push(r);
  }

  // Many2one = FK to another model
  if (byType['many2one']?.length) {
    lines.push(`### Many-to-One (Foreign Keys) - ${byType['many2one'].length}`);
    lines.push(`*Fields that link to ONE record in another model*\n`);

    for (const { payload: p } of byType['many2one']) {
      const payload = p as SchemaPayload;
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

    for (const { payload: p } of byType['one2many']) {
      const payload = p as SchemaPayload;
      lines.push(`- **${payload.field_name}** (${payload.field_label})`);
      lines.push(`  → Shows records from: ${payload.primary_data_location}`);
    }
    lines.push('');
  }

  // Many2many = bidirectional relationship
  if (byType['many2many']?.length) {
    lines.push(`### Many-to-Many - ${byType['many2many'].length}`);
    lines.push(`*Fields with bidirectional many-to-many relationship*\n`);

    for (const { payload: p } of byType['many2many']) {
      const payload = p as SchemaPayload;
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
 * Note: References mode only works with schema, so we cast payloads to SchemaPayload
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
    const payload = r.payload as SchemaPayload;
    const sourceModel = payload.model_name;
    if (!byModel[sourceModel]) byModel[sourceModel] = [];
    byModel[sourceModel].push(r);
  }

  lines.push(`**Referenced from ${Object.keys(byModel).length} models:**\n`);

  for (const [sourceModel, fields] of Object.entries(byModel).sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${sourceModel} (${fields.length} field${fields.length > 1 ? 's' : ''})`);

    for (const { payload: p } of fields) {
      const payload = p as SchemaPayload;
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
