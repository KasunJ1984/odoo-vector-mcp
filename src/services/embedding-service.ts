/**
 * Embedding Service
 *
 * Generates vector embeddings using Voyage AI.
 * Uses voyage-3 model (1024 dimensions).
 */

import { VoyageAIClient } from 'voyageai';
import { VOYAGE_CONFIG } from '../constants.js';

// =============================================================================
// CLIENT INITIALIZATION
// =============================================================================

let voyageClient: VoyageAIClient | null = null;

/**
 * Initialize the Voyage AI client
 */
export function initializeEmbeddingService(): boolean {
  if (!VOYAGE_CONFIG.API_KEY) {
    console.error('[Embedding] VOYAGE_API_KEY not set - embedding service disabled');
    return false;
  }

  try {
    voyageClient = new VoyageAIClient({ apiKey: VOYAGE_CONFIG.API_KEY });
    console.error('[Embedding] Voyage AI service initialized');
    return true;
  } catch (error) {
    console.error('[Embedding] Failed to initialize:', error);
    return false;
  }
}

/**
 * Check if embedding service is available
 */
export function isEmbeddingServiceAvailable(): boolean {
  return voyageClient !== null;
}

// =============================================================================
// EMBEDDING FUNCTIONS
// =============================================================================

/**
 * Generate embedding for a single text
 *
 * @param text - Text to embed
 * @param inputType - 'document' for indexing, 'query' for search queries
 */
export async function embed(
  text: string,
  inputType: 'document' | 'query' = 'document'
): Promise<number[]> {
  if (!voyageClient) {
    throw new Error('Embedding service not initialized');
  }

  // Truncate if too long (rough estimate: 4 chars per token, max ~8000 tokens)
  const maxChars = 30000;
  const truncatedText = text.length > maxChars ? text.slice(0, maxChars) : text;

  const response = await voyageClient.embed({
    input: truncatedText,
    model: VOYAGE_CONFIG.MODEL,
    inputType: inputType,
  });

  if (!response.data || !response.data[0] || !response.data[0].embedding) {
    throw new Error('Invalid embedding response');
  }

  return response.data[0].embedding;
}

/**
 * Generate embeddings for multiple texts (batch)
 *
 * @param texts - Array of texts to embed
 * @param inputType - 'document' for indexing, 'query' for search queries
 * @param onProgress - Optional progress callback
 */
export async function embedBatch(
  texts: string[],
  inputType: 'document' | 'query' = 'document',
  onProgress?: (current: number, total: number) => void
): Promise<number[][]> {
  if (!voyageClient) {
    throw new Error('Embedding service not initialized');
  }

  const results: number[][] = [];
  const batchSize = VOYAGE_CONFIG.MAX_BATCH_SIZE;

  // Truncate each text if too long
  const maxChars = 30000;
  const truncatedTexts = texts.map(t => t.length > maxChars ? t.slice(0, maxChars) : t);

  // Process in batches
  for (let i = 0; i < truncatedTexts.length; i += batchSize) {
    const batch = truncatedTexts.slice(i, i + batchSize);

    const response = await voyageClient.embed({
      input: batch,
      model: VOYAGE_CONFIG.MODEL,
      inputType: inputType,
    });

    if (!response.data) {
      throw new Error('Invalid batch embedding response');
    }

    for (const item of response.data) {
      if (item.embedding) {
        results.push(item.embedding);
      }
    }

    if (onProgress) {
      onProgress(Math.min(i + batchSize, truncatedTexts.length), truncatedTexts.length);
    }
  }

  return results;
}

/**
 * Estimate token count for cost calculation (rough)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
