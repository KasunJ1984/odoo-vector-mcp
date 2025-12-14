/**
 * Re-sync Script
 *
 * Triggers a full re-sync of schema data to Qdrant with force_recreate=true.
 * This re-embeds all 17,930 fields with the new coordinate-aware semantic text.
 *
 * Usage: npx tsx scripts/resync.ts
 */

import 'dotenv/config';
import { initializeEmbeddingService } from '../src/services/embedding-service.js';
import { initializeVectorClient } from '../src/services/vector-client.js';
import { syncSchemaToQdrant } from '../src/services/schema-sync.js';

async function main() {
  console.log('='.repeat(60));
  console.log('Odoo Schema Re-Sync (force_recreate=true)');
  console.log('='.repeat(60));
  console.log('');

  // Initialize services
  console.log('[1/3] Initializing embedding service...');
  const embeddingReady = initializeEmbeddingService();
  if (!embeddingReady) {
    console.error('ERROR: Embedding service not available. Set VOYAGE_API_KEY.');
    process.exit(1);
  }
  console.log('      Embedding service ready (Voyage AI)');

  console.log('[2/3] Initializing vector client...');
  const vectorReady = initializeVectorClient();
  if (!vectorReady) {
    console.error('ERROR: Vector client not available. Check QDRANT_HOST.');
    process.exit(1);
  }
  console.log('      Vector client ready (Qdrant)');

  // Run sync
  console.log('[3/3] Starting full sync with force_recreate=true...');
  console.log('      This will delete the existing collection and re-embed all 17,930 fields.');
  console.log('      Progress will be shown below:');
  console.log('');

  const result = await syncSchemaToQdrant(true, (phase, current, total) => {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    process.stdout.write(`\r      [${phase}] ${current}/${total} (${percent}%)   `);
  });

  console.log('\n');
  console.log('='.repeat(60));
  console.log('SYNC COMPLETE');
  console.log('='.repeat(60));
  console.log(`Success: ${result.success}`);
  console.log(`Uploaded: ${result.uploaded.toLocaleString()} schemas`);
  console.log(`Failed: ${result.failed}`);
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)} seconds`);

  if (result.errors && result.errors.length > 0) {
    console.log('');
    console.log('Errors:');
    for (const err of result.errors.slice(0, 10)) {
      console.log(`  - ${err}`);
    }
    if (result.errors.length > 10) {
      console.log(`  ... and ${result.errors.length - 10} more`);
    }
  }

  console.log('');
  process.exit(result.success ? 0 : 1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
