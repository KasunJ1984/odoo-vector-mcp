/**
 * Data Transform Tool
 *
 * MCP tool for transforming and syncing Odoo table data to vector database.
 * Provides two tools:
 * 1. transform_data - Sync crm.lead data (requires trigger code)
 * 2. preview_encoding - Preview encoding map for any model (no sync)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TransformDataSchema, PreviewEncodingSchema } from '../schemas/index.js';
import type { TransformDataInput, PreviewEncodingInput } from '../schemas/index.js';
import { syncModelData, getDataSyncStatus } from '../services/data-sync.js';
import { previewEncodingMap } from '../services/data-transformer.js';
import { DATA_TRANSFORM_CONFIG } from '../constants.js';

// =============================================================================
// TOOL REGISTRATION
// =============================================================================

/**
 * Register data transform tools with the MCP server
 */
export function registerDataTools(server: McpServer): void {
  // =========================================================================
  // TRANSFORM DATA TOOL
  // =========================================================================

  server.tool(
    'transform_data',
    `Transform and sync Odoo crm.lead data to vector database.

**DATA ENCODING FORMAT:**
Unlike schema (4^XX*), data uses: [model_id]^[field_id]*VALUE

Example crm.lead record (model_id=344):
\`344^6327*12345|344^6299*450000|78^956*201|345^6237*4\`

Where:
- \`344^6327*12345\` = crm.lead.id = 12345
- \`344^6299*450000\` = expected_revenue = 450000
- \`78^956*201\` = partner_id → res.partner id=201 (FK uses TARGET model prefix!)
- \`345^6237*4\` = stage_id → crm.stage id=4

**TRIGGER FORMAT:**
To prevent accidental syncs, you MUST use the exact command:
\`transfer_crm.lead_1984\`

**SCHEMA VALIDATION:**
Before sync, the tool validates that ALL Odoo fields have schema entries.
If any field is missing from schema, sync will ABORT with error.

**DEFAULT BEHAVIOR:**
- Syncs ALL records in crm.lead table (including archived/inactive)
- No limit by default - full table sync
- Use test_limit ONLY for debugging

**EXAMPLES:**
- Full sync: \`{ "command": "transfer_crm.lead_1984" }\`
- Exclude archived: \`{ "command": "transfer_crm.lead_1984", "include_archived": false }\`
- Test with 10 records: \`{ "command": "transfer_crm.lead_1984", "test_limit": 10 }\``,
    TransformDataSchema.shape,
    async (args) => {
      try {
        const input = TransformDataSchema.parse(args) as TransformDataInput;

        // Validate the trigger command
        if (input.command !== 'transfer_crm.lead_1984') {
          return {
            content: [{
              type: 'text',
              text: `Invalid command. Use exactly: transfer_crm.lead_1984`,
            }],
          };
        }

        // Get crm.lead configuration
        const config = {
          model_name: DATA_TRANSFORM_CONFIG.MODELS.CRM_LEAD.model_name,
          model_id: DATA_TRANSFORM_CONFIG.MODELS.CRM_LEAD.model_id,
          id_field_id: DATA_TRANSFORM_CONFIG.MODELS.CRM_LEAD.id_field_id,
          include_archived: input.include_archived,
          test_limit: input.test_limit,
        };

        // Progress tracking
        let lastPhase = '';
        const progressUpdates: string[] = [];

        // Execute sync
        const result = await syncModelData(config, (phase, current, total) => {
          if (phase !== lastPhase) {
            progressUpdates.push(`[${phase}] ${current}/${total}`);
            lastPhase = phase;
          }
        });

        // Format result
        const lines: string[] = [];

        if (result.success) {
          lines.push(`Data Sync Complete`);
          lines.push(`===================`);
          lines.push(`Model: ${result.model_name}`);
          lines.push(`Records Processed: ${result.records_processed}`);
          lines.push(`Records Embedded: ${result.records_embedded}`);
          lines.push(`Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);

          if (result.records_failed > 0) {
            lines.push(`Records Failed: ${result.records_failed}`);
          }
        } else {
          lines.push(`Data Sync FAILED`);
          lines.push(`=================`);
          lines.push(`Model: ${result.model_name}`);

          if (result.errors && result.errors.length > 0) {
            lines.push(``);
            lines.push(`Errors:`);
            for (const error of result.errors) {
              lines.push(`  - ${error}`);
            }
          }
        }

        return {
          content: [{
            type: 'text',
            text: lines.join('\n'),
          }],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: 'text',
            text: `Error: ${errMsg}`,
          }],
        };
      }
    }
  );

  // =========================================================================
  // PREVIEW ENCODING TOOL
  // =========================================================================

  server.tool(
    'preview_encoding',
    `Preview the encoding map for a model (no sync).

Shows how each field will be encoded for vector embedding.
Useful for understanding the coordinate format before syncing.

**FK PREFIX RULE:**
- Native fields use model's own prefix: \`344^6299*\` for expected_revenue
- FK fields use TARGET model's prefix: \`78^956*\` for partner_id → res.partner

**EXAMPLES:**
- Preview crm.lead: \`{ "model_name": "crm.lead" }\`
- Preview res.partner: \`{ "model_name": "res.partner" }\``,
    PreviewEncodingSchema.shape,
    async (args) => {
      try {
        const input = PreviewEncodingSchema.parse(args) as PreviewEncodingInput;

        const preview = previewEncodingMap(input.model_name);

        const lines: string[] = [];
        lines.push(`Encoding Map for ${preview.model_name}`);
        lines.push(`=`.repeat(40));
        lines.push(`Total Fields: ${preview.field_count}`);
        lines.push(``);
        lines.push(`Sample Prefixes (first 20):`);
        lines.push(`-`.repeat(40));

        for (const item of preview.sample_prefixes) {
          const fkMarker = preview.encoding_map[item.field_name].is_foreign_key ? ' [FK]' : '';
          lines.push(`${item.field_name}: ${item.prefix}* (${item.type})${fkMarker}`);
        }

        if (preview.field_count > 20) {
          lines.push(`... and ${preview.field_count - 20} more fields`);
        }

        return {
          content: [{
            type: 'text',
            text: lines.join('\n'),
          }],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: 'text',
            text: `Error: ${errMsg}`,
          }],
        };
      }
    }
  );

  // =========================================================================
  // DATA STATUS TOOL (using sync tool pattern)
  // =========================================================================

  server.tool(
    'data_status',
    `Check the status of data sync in the vector database.

Shows:
- Total points in collection
- Schema points vs Data points
- Collection name`,
    {},
    async () => {
      try {
        const status = await getDataSyncStatus();

        const lines: string[] = [];
        lines.push(`Data Sync Status`);
        lines.push(`================`);
        lines.push(`Collection: ${status.collection}`);
        lines.push(`Total Points: ${status.total_points}`);
        lines.push(`Schema Points: ${status.schema_points}`);
        lines.push(`Data Points: ${status.data_points}`);

        return {
          content: [{
            type: 'text',
            text: lines.join('\n'),
          }],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: 'text',
            text: `Error: ${errMsg}`,
          }],
        };
      }
    }
  );

  console.error('[DataTool] Registered 3 data tools: transform_data, preview_encoding, data_status');
}
