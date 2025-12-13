/**
 * Sync Service
 *
 * Orchestrates data synchronization from Odoo to the vector database.
 *
 * Flow:
 * 1. Fetch opportunities from Odoo (10 tables of data)
 * 2. Encode each opportunity to numeric prefixed string (1^10*value format)
 * 3. Build semantic text for embedding
 * 4. Generate embeddings
 * 5. Upsert to crm_data collection with encoded string in payload
 */

import { SYNC_CONFIG, QDRANT_CONFIG } from '../constants.js';
import { fetchAllLeads, fetchLeadById } from './odoo-client.js';
import { encodeOpportunity, buildSemanticText } from './encoder-service.js';
import { embedBatch, isEmbeddingServiceAvailable } from './embedding-service.js';
import {
  upsertDataPoints,
  clearDataCollection,
  getCollectionInfo,
  collectionExists,
  createDataCollection,
} from './vector-client.js';
import type { CrmLead, SyncResult, SyncProgress, SyncStatus, OpportunityPayload } from '../types.js';
import { isValidRelation, getRelationName, getRelationId } from '../types.js';

// =============================================================================
// SYNC STATE
// =============================================================================

let lastSyncTime: string | null = null;
let totalRecords: number = 0;
let isRunning: boolean = false;

// =============================================================================
// FULL SYNC
// =============================================================================

/**
 * Perform a full sync - rebuild the entire crm_data collection.
 *
 * Steps:
 * 1. Fetch all opportunities from Odoo
 * 2. Clear existing data collection
 * 3. For each batch:
 *    a. Encode to prefixed strings
 *    b. Build semantic texts
 *    c. Generate embeddings
 *    d. Upsert to Qdrant
 *
 * @param onProgress Optional progress callback
 */
export async function fullSync(
  onProgress?: (progress: SyncProgress) => void
): Promise<SyncResult> {
  if (isRunning) {
    return {
      success: false,
      recordsSynced: 0,
      recordsFailed: 0,
      durationMs: 0,
      errors: ['Sync already in progress'],
    };
  }

  if (!isEmbeddingServiceAvailable()) {
    return {
      success: false,
      recordsSynced: 0,
      recordsFailed: 0,
      durationMs: 0,
      errors: ['Embedding service not available'],
    };
  }

  isRunning = true;
  const startTime = Date.now();
  const errors: string[] = [];
  let recordsSynced = 0;
  let recordsFailed = 0;

  try {
    // Phase 1: Fetch all leads from Odoo
    if (onProgress) {
      onProgress({ phase: 'fetching', current: 0, total: 0, message: 'Fetching opportunities from Odoo...' });
    }

    console.error('[Sync] Fetching opportunities from Odoo...');
    const leads = await fetchAllLeads((current, total) => {
      if (onProgress) {
        onProgress({ phase: 'fetching', current, total, message: `Fetching ${current}/${total} opportunities` });
      }
    });

    console.error(`[Sync] Fetched ${leads.length} opportunities`);

    if (leads.length === 0) {
      return {
        success: true,
        recordsSynced: 0,
        recordsFailed: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // Phase 2: Clear and recreate data collection
    if (onProgress) {
      onProgress({ phase: 'encoding', current: 0, total: leads.length, message: 'Preparing data collection...' });
    }

    const exists = await collectionExists(QDRANT_CONFIG.DATA_COLLECTION);
    if (exists) {
      await clearDataCollection();
    } else {
      await createDataCollection();
    }

    // Phase 3: Process in batches
    const batchSize = SYNC_CONFIG.BATCH_SIZE;

    for (let i = 0; i < leads.length; i += batchSize) {
      const batch = leads.slice(i, i + batchSize);

      try {
        // Encode and build semantic texts
        if (onProgress) {
          onProgress({
            phase: 'encoding',
            current: i,
            total: leads.length,
            message: `Encoding batch ${Math.floor(i / batchSize) + 1}...`
          });
        }

        const encodedStrings = batch.map(lead => encodeOpportunity(lead));
        const semanticTexts = batch.map(lead => buildSemanticText(lead));

        // Generate embeddings
        if (onProgress) {
          onProgress({
            phase: 'embedding',
            current: i,
            total: leads.length,
            message: `Generating embeddings for batch ${Math.floor(i / batchSize) + 1}...`
          });
        }

        const embeddings = await embedBatch(semanticTexts, 'document');

        // Build payloads and upsert
        if (onProgress) {
          onProgress({
            phase: 'upserting',
            current: i,
            total: leads.length,
            message: `Upserting batch ${Math.floor(i / batchSize) + 1}...`
          });
        }

        const points = batch.map((lead, idx) => ({
          id: lead.id,
          vector: embeddings[idx],
          payload: buildPayload(lead, encodedStrings[idx], semanticTexts[idx]),
        }));

        await upsertDataPoints(points);
        recordsSynced += batch.length;

      } catch (batchError) {
        const errorMsg = batchError instanceof Error ? batchError.message : String(batchError);
        errors.push(`Batch ${Math.floor(i / batchSize) + 1} failed: ${errorMsg}`);
        recordsFailed += batch.length;
        console.error(`[Sync] Batch error:`, errorMsg);
      }
    }

    // Update state
    lastSyncTime = new Date().toISOString();
    totalRecords = recordsSynced;

    console.error(`[Sync] Complete: ${recordsSynced} synced, ${recordsFailed} failed`);

    return {
      success: errors.length === 0,
      recordsSynced,
      recordsFailed,
      durationMs: Date.now() - startTime,
      errors: errors.length > 0 ? errors : undefined,
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Sync] Fatal error:', errorMsg);
    return {
      success: false,
      recordsSynced,
      recordsFailed,
      durationMs: Date.now() - startTime,
      errors: [errorMsg],
    };

  } finally {
    isRunning = false;
  }
}

// =============================================================================
// SINGLE RECORD SYNC
// =============================================================================

/**
 * Sync a single opportunity by ID.
 *
 * Useful for webhook-triggered updates.
 *
 * @param leadId Odoo lead ID
 */
export async function syncRecord(leadId: number): Promise<SyncResult> {
  if (!isEmbeddingServiceAvailable()) {
    return {
      success: false,
      recordsSynced: 0,
      recordsFailed: 0,
      durationMs: 0,
      errors: ['Embedding service not available'],
    };
  }

  const startTime = Date.now();

  try {
    // Fetch the lead
    const lead = await fetchLeadById(leadId);

    if (!lead) {
      return {
        success: false,
        recordsSynced: 0,
        recordsFailed: 1,
        durationMs: Date.now() - startTime,
        errors: [`Lead ${leadId} not found`],
      };
    }

    // Encode and build semantic text
    const encodedString = encodeOpportunity(lead);
    const semanticText = buildSemanticText(lead);

    // Generate embedding
    const embeddings = await embedBatch([semanticText], 'document');

    // Upsert
    await upsertDataPoints([{
      id: lead.id,
      vector: embeddings[0],
      payload: buildPayload(lead, encodedString, semanticText),
    }]);

    console.error(`[Sync] Synced record ${leadId}`);

    return {
      success: true,
      recordsSynced: 1,
      recordsFailed: 0,
      durationMs: Date.now() - startTime,
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Sync] Error syncing record ${leadId}:`, errorMsg);
    return {
      success: false,
      recordsSynced: 0,
      recordsFailed: 1,
      durationMs: Date.now() - startTime,
      errors: [errorMsg],
    };
  }
}

// =============================================================================
// SYNC STATUS
// =============================================================================

/**
 * Get current sync status
 */
export async function getSyncStatus(): Promise<SyncStatus> {
  const info = await getCollectionInfo(QDRANT_CONFIG.DATA_COLLECTION);

  return {
    lastSync: lastSyncTime,
    totalRecords: info.vectorCount,
    isRunning,
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Build payload for vector storage
 *
 * Includes all indexed fields for filtering and semantic fields for display
 */
function buildPayload(lead: CrmLead, encodedString: string, semanticText: string): OpportunityPayload {
  const isLost = !lead.active || isValidRelation(lead.lost_reason_id);

  return {
    odoo_id: lead.id,
    entity_type: 'opportunity',
    encoded_string: encodedString,
    semantic_text: semanticText,

    // Core indexed fields for filtering (Tables 1-7)
    stage_id: getRelationId(lead.stage_id),
    user_id: getRelationId(lead.user_id),
    team_id: getRelationId(lead.team_id),
    expected_revenue: lead.expected_revenue,
    probability: lead.probability,
    is_won: lead.probability === 100,  // Derived from probability (Odoo sets 100% for won)
    is_lost: isLost,
    is_active: lead.active !== false,
    city: typeof lead.city === 'string' ? lead.city : undefined,
    state_name: getRelationName(lead.state_id) || undefined,
    create_date: lead.create_date,

    // New indexed fields for Tables 8-10
    specification_id: getRelationId(lead.x_specification_id),
    specification_name: getRelationName(lead.x_specification_id) || undefined,
    lead_source_id: getRelationId(lead.x_lead_source_id),
    lead_source_name: getRelationName(lead.x_lead_source_id) || undefined,
    architect_id: getRelationId(lead.x_architect_id),
    architect_name: getRelationName(lead.x_architect_id) || undefined,

    // Semantic fields for rich display
    opportunity_name: lead.name,
    contact_name: getRelationName(lead.partner_id) || undefined,
    stage_name: getRelationName(lead.stage_id) || undefined,
    user_name: getRelationName(lead.user_id) || undefined,
    team_name: getRelationName(lead.team_id) || undefined,
    lost_reason_name: getRelationName(lead.lost_reason_id) || undefined,

    // Sync metadata
    sync_timestamp: new Date().toISOString(),
  };
}
