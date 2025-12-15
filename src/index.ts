/**
 * odoo-vector-mcp - Odoo Schema Semantic Search MCP Server
 *
 * Redesigned for comprehensive Odoo schema search using semantic embeddings.
 * Searches 17,930 fields across 800+ models to find:
 * - Where data is stored
 * - Field relationships
 * - Data types and locations
 *
 * Phase 1: Schema semantic search
 * Phase 2: Will add data extraction using Odoo client
 *
 * Supports two transport modes:
 * - stdio: For Desktop Claude & Claude Code
 * - http: For Railway cloud deployment & Claude.ai browser
 */

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Request, Response } from 'express';
import { registerSearchTools } from './tools/search-tool.js';
import { registerDataTools } from './tools/data-tool.js';
import { initializeEmbeddingService } from './services/embedding-service.js';
import { initializeVectorClient } from './services/vector-client.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const TRANSPORT = process.env.TRANSPORT || 'stdio';
const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

// =============================================================================
// MCP SERVER INSTANCE
// =============================================================================

const server = new McpServer({
  name: 'odoo-vector-mcp',
  version: '0.2.0',
});

// Register search tools (semantic_search + sync)
registerSearchTools(server);

// Register data transform tools (transform_data, preview_encoding, data_status)
registerDataTools(server);

// =============================================================================
// STDIO TRANSPORT (for Desktop Claude & Claude Code)
// =============================================================================

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('odoo-vector-mcp running on stdio');

  // Initialize services asynchronously (non-blocking)
  initializeServices()
    .then(() => console.error('Services initialized successfully'))
    .catch(err => console.error('Service initialization error:', err instanceof Error ? err.message : err));
}

// =============================================================================
// HTTP TRANSPORT (for Railway & Claude.ai browser)
// =============================================================================

async function runHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS headers for browser access
  app.use((_req: Request, res: Response, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
  });

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'odoo-vector-mcp',
      version: '0.2.0',
      transport: 'http',
      description: 'Odoo Schema Semantic Search'
    });
  });

  // MCP endpoint - stateless, creates new transport per request
  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
        enableJsonResponse: true
      });

      res.on('close', () => {
        transport.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // CORS preflight
  app.options('/mcp', (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  // Initialize services before starting server
  await initializeServices();

  app.listen(PORT, HOST, () => {
    console.error(`odoo-vector-mcp running on http://${HOST}:${PORT}/mcp`);
    console.error('Endpoints:');
    console.error(`  GET  /health - Health check`);
    console.error(`  POST /mcp    - MCP endpoint`);
    console.error('');
    console.error('Tools available:');
    console.error('  - semantic_search: Search Odoo schema semantically');
    console.error('  - sync: Upload schema to vector database');
    console.error('  - transform_data: Sync crm.lead data to vector database');
    console.error('  - preview_encoding: Preview encoding map for a model');
    console.error('  - data_status: Check data sync status');
  });
}

// =============================================================================
// SERVICE INITIALIZATION
// =============================================================================

async function initializeServices(): Promise<void> {
  console.error('[Init] Initializing services...');

  // 1. Initialize embedding service (Voyage AI)
  const embeddingReady = initializeEmbeddingService();
  if (!embeddingReady) {
    console.error('[Init] Warning: Embedding service not available. Set VOYAGE_API_KEY.');
  } else {
    console.error('[Init] Embedding service ready');
  }

  // 2. Initialize vector client (Qdrant)
  const vectorReady = initializeVectorClient();
  if (!vectorReady) {
    console.error('[Init] Warning: Vector client not available. Check QDRANT_HOST.');
  } else {
    console.error('[Init] Vector client ready');
  }

  // Note: Schema collection is initialized via the 'sync' tool
  // Use sync with action="full_sync" to upload schema data
  console.error('[Init] Use sync tool with action="full_sync" to upload schema');
}

// =============================================================================
// ENTRY POINT
// =============================================================================

if (TRANSPORT === 'http') {
  runHttp().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
} else {
  runStdio().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
