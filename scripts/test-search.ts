/**
 * Test Search Quality Script
 *
 * Verifies search quality after HNSW + Voyage-3.5 upgrade.
 *
 * Usage: npx tsx scripts/test-search.ts
 */

import 'dotenv/config';
import { initializeEmbeddingService, embed } from '../src/services/embedding-service.js';
import { initializeVectorClient, searchSchemaCollection, getCollectionInfo } from '../src/services/vector-client.js';
import { QDRANT_CONFIG } from '../src/constants.js';

interface TestCase {
  query: string;
  expectedFields: string[];  // Expected field names or model.field combinations
  description: string;
}

const testCases: TestCase[] = [
  {
    query: 'customer email',
    expectedFields: ['email', 'partner_email', 'email_from'],
    description: 'Should find email-related fields',
  },
  {
    query: 'opportunity revenue',
    expectedFields: ['expected_revenue', 'revenue', 'amount'],
    description: 'Should find revenue fields in CRM',
  },
  {
    query: 'salesperson name',
    expectedFields: ['user_id', 'name', 'salesperson'],
    description: 'Should find salesperson/user fields',
  },
  {
    query: 'invoice date',
    expectedFields: ['invoice_date', 'date_invoice', 'date'],
    description: 'Should find invoice date fields',
  },
  {
    query: 'product price',
    expectedFields: ['price', 'list_price', 'standard_price', 'price_unit'],
    description: 'Should find product price fields',
  },
];

async function runTests() {
  console.log('='.repeat(70));
  console.log('SEARCH QUALITY TEST - HNSW + Voyage-3.5');
  console.log('='.repeat(70));
  console.log('');

  // Initialize services
  console.log('[Setup] Initializing services...');
  const embeddingReady = initializeEmbeddingService();
  if (!embeddingReady) {
    console.error('ERROR: Embedding service not available');
    process.exit(1);
  }

  const vectorReady = initializeVectorClient();
  if (!vectorReady) {
    console.error('ERROR: Vector client not available');
    process.exit(1);
  }

  // Get collection info
  const info = await getCollectionInfo(QDRANT_CONFIG.COLLECTION);
  console.log(`[Setup] Collection: ${QDRANT_CONFIG.COLLECTION}`);
  console.log(`[Setup] Vector count: ${info.vectorCount.toLocaleString()}`);
  console.log('');

  // Run tests
  let passed = 0;
  let failed = 0;

  for (const test of testCases) {
    console.log('-'.repeat(70));
    console.log(`Query: "${test.query}"`);
    console.log(`Expected: ${test.description}`);
    console.log('');

    try {
      const startTime = Date.now();
      const embedding = await embed(test.query, 'query');
      const embeddingTime = Date.now() - startTime;

      const searchStart = Date.now();
      const results = await searchSchemaCollection(embedding, {
        limit: 5,
        minScore: 0.3,
      });
      const searchTime = Date.now() - searchStart;

      console.log(`Results (${results.length} found, embed: ${embeddingTime}ms, search: ${searchTime}ms):`);

      let foundExpected = false;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const fieldName = r.payload.field_name;
        const modelName = r.payload.model_name;
        const score = r.payload ? r.score.toFixed(3) : 'N/A';

        // Check if this is an expected field
        const isExpected = test.expectedFields.some(
          exp => fieldName.includes(exp) || exp.includes(fieldName)
        );

        if (isExpected) foundExpected = true;

        const marker = isExpected ? '✓' : ' ';
        console.log(`  ${i + 1}. [${marker}] ${modelName}.${fieldName} (score: ${score})`);
        console.log(`       Label: ${r.payload.field_label}`);
      }

      if (foundExpected) {
        console.log('\n  ✅ PASS - Found expected field in top results');
        passed++;
      } else {
        console.log('\n  ❌ FAIL - Expected field not in top results');
        failed++;
      }
    } catch (error) {
      console.error(`  ERROR: ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    }
    console.log('');
  }

  // Summary
  console.log('='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Passed: ${passed}/${testCases.length}`);
  console.log(`Failed: ${failed}/${testCases.length}`);
  console.log(`Success Rate: ${((passed / testCases.length) * 100).toFixed(0)}%`);
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
