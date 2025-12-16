/**
 * Data Transform Tool
 *
 * MCP tool for transforming and syncing Odoo table data to vector database.
 * Provides three tools:
 * 1. transform_data - Sync ANY model data (dynamic model discovery!)
 *    - Command format: transfer_[model.name]_1984
 *    - Examples: transfer_crm.lead_1984, transfer_res.partner_1984
 * 2. preview_encoding - Preview encoding map for any model (no sync)
 * 3. data_status - Check sync status in vector database
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TransformDataSchema, PreviewEncodingSchema } from '../schemas/index.js';
import type { TransformDataInput, PreviewEncodingInput } from '../schemas/index.js';
import {
  syncModelData,
  getDataSyncStatus,
  extractModelNameFromCommand,
  discoverModelConfig,
} from '../services/data-sync.js';
import { previewEncodingMap } from '../services/data-transformer.js';

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
    `Transform and sync ANY Odoo model data to vector database.

**DYNAMIC MODEL SUPPORT:**
This tool now supports ANY Odoo model! The model configuration (model_id, fields)
is automatically discovered from the schema.

**TRIGGER FORMAT:**
\`transfer_[model.name]_1984\`

Examples:
- \`transfer_crm.lead_1984\` → Sync CRM leads
- \`transfer_res.partner_1984\` → Sync contacts/partners
- \`transfer_sale.order_1984\` → Sync sales orders
- \`transfer_product.product_1984\` → Sync products

**DATA ENCODING FORMAT:**
Each record is encoded as: [model_id]^[field_id]*VALUE

Example crm.lead record (model_id=344):
\`344^6327*12345|344^6299*450000|78^956*201|345^6237*4\`

**HOW IT WORKS:**
1. Extracts model name from command (e.g., "res.partner" from "transfer_res.partner_1984")
2. Discovers model_id and fields from schema automatically
3. Validates ALL fields exist in schema before sync
4. Fetches ALL records from Odoo
5. Encodes and embeds each record
6. Uploads to vector database

**SCHEMA VALIDATION:**
Before sync, the tool validates that ALL Odoo fields have schema entries.
If any field is missing from schema, sync will ABORT with error.
Run schema sync first if needed.

**DEFAULT BEHAVIOR:**
- INCREMENTAL sync by default - only syncs new/updated records since last sync
- First sync is always FULL (no previous timestamp exists)
- Use force_full=true to force full sync when needed
- Use test_limit ONLY for debugging

**INCREMENTAL SYNC:**
After first sync, only records with write_date > last_sync_timestamp are fetched.
This dramatically reduces sync time for large tables with few changes.

**EXAMPLES:**
- Sync CRM leads: \`{ "command": "transfer_crm.lead_1984" }\`
- Force full sync: \`{ "command": "transfer_crm.lead_1984", "force_full": true }\`
- Sync partners: \`{ "command": "transfer_res.partner_1984" }\`
- Exclude archived: \`{ "command": "transfer_res.partner_1984", "include_archived": false }\`
- Test with 10 records: \`{ "command": "transfer_crm.lead_1984", "test_limit": 10 }\``,
    TransformDataSchema.shape,
    async (args) => {
      try {
        const input = TransformDataSchema.parse(args) as TransformDataInput;

        // Extract model name from the command dynamically
        let modelName: string;
        try {
          modelName = extractModelNameFromCommand(input.command);
        } catch {
          return {
            content: [{
              type: 'text',
              text: `Invalid command format.\n\nExpected: transfer_[model.name]_1984\nExamples:\n- transfer_crm.lead_1984\n- transfer_res.partner_1984\n- transfer_sale.order_1984`,
            }],
          };
        }

        // Discover model configuration from schema
        let discoveredConfig;
        try {
          discoveredConfig = discoverModelConfig(modelName);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          return {
            content: [{
              type: 'text',
              text: `Model Discovery Failed\n======================\n${errMsg}`,
            }],
          };
        }

        // Build the configuration for sync
        const config = {
          model_name: discoveredConfig.model_name,
          model_id: discoveredConfig.model_id,
          id_field_id: discoveredConfig.id_field_id,
          include_archived: input.include_archived,
          test_limit: input.test_limit,
          incremental: input.incremental,
          force_full: input.force_full,
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
          lines.push(`Sync Type: ${result.sync_type || 'full'}`);
          lines.push(`Records Processed: ${result.records_processed}`);
          lines.push(`Records Embedded: ${result.records_embedded}`);
          lines.push(`Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);

          if (result.records_failed > 0) {
            lines.push(`Records Failed: ${result.records_failed}`);
          }

          // Show restricted fields if any
          if (result.restricted_fields && result.restricted_fields.length > 0) {
            lines.push(``);
            lines.push(`Field Restrictions (${result.restricted_fields.length} fields):`);
            lines.push(`----------------------------------------`);

            // Group by reason
            const byReason = new Map<string, string[]>();
            for (const field of result.restricted_fields) {
              const list = byReason.get(field.reason) || [];
              list.push(field.field_name);
              byReason.set(field.reason, list);
            }

            // Show API restrictions first
            const apiReasons = ['security_restriction', 'compute_error', 'unknown'];
            for (const reason of apiReasons) {
              const fields = byReason.get(reason);
              if (fields && fields.length > 0) {
                lines.push(`${reason}: ${fields.join(', ')}`);
              }
            }

            // Show Odoo errors separately
            const odooFields = byReason.get('odoo_error');
            if (odooFields && odooFields.length > 0) {
              lines.push(``);
              lines.push(`Odoo Errors (${odooFields.length} fields):`);
              lines.push(`odoo_error: ${odooFields.join(', ')}`);
            }

            lines.push(``);
            lines.push(`NOTE: Restricted fields decode as "[API Restricted]" or "[Odoo Error]".`);
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

          // Show restricted fields even on failure (might help debugging)
          if (result.restricted_fields && result.restricted_fields.length > 0) {
            lines.push(``);
            lines.push(`Restricted Fields Found (${result.restricted_fields.length}):`);
            for (const field of result.restricted_fields) {
              lines.push(`  - ${field.field_name} (${field.reason})`);
            }
          }
        }

        // Show warnings if any
        if (result.warnings && result.warnings.length > 0) {
          lines.push(``);
          lines.push(`Warnings:`);
          for (const warning of result.warnings.slice(0, 10)) {
            lines.push(`  - ${warning}`);
          }
          if (result.warnings.length > 10) {
            lines.push(`  ... and ${result.warnings.length - 10} more warnings`);
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
