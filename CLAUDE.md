# CLAUDE.md - odoo-vector-mcp

Self-Describing Vector Database MCP Server for Odoo CRM.

## Overview

This MCP server implements a **self-describing vector database architecture** that encodes CRM data using source-table-prefixed strings. The key innovation is that Claude can **semantically discover** field meanings by searching the schema collection.

## Core Innovation: Source-Table Prefixes

Each field code indicates which Odoo table it comes from:

| Prefix | Odoo Table | Description |
|--------|------------|-------------|
| `O_` | crm.lead | Opportunity fields |
| `C_` | res.partner | Contact/Company fields |
| `S_` | crm.stage | Pipeline stage fields |
| `U_` | res.users | User/Salesperson fields |
| `T_` | crm.team | Sales team fields |
| `ST_` | res.country.state | State/Territory fields |
| `LR_` | crm.lost.reason | Lost reason fields |

**Example encoded string:**
```
O_1*Hospital Project|O_2*56805|O_10*450000|C_1*Hansen Yuncken|S_1*Tender RFQ|U_1*Ron Simpson
```

## MCP Tools (4 total)

### 1. `vector_discover_schema`
Search schema definitions by semantic meaning. **This is the key innovation.**

```
Query: "fields about revenue"
Result: O_10 (expected_revenue) - Deal value in dollars
```

### 2. `vector_semantic_search`
Natural language search across opportunities.

```
Query: "hospital projects in Victoria"
Returns: Matching opportunities with encoded strings
```

### 3. `vector_decode`
Decode an encoded string to structured data.

```
Input: "O_1*Hospital|O_10*450000|C_1*Hansen"
Output: Structured data organized by source table
```

### 4. `vector_sync`
Sync data from Odoo to the vector database.

```
Actions: status, full_sync, sync_record
```

## Build & Run

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run server (stdio mode)
npm start

# Development mode
npm run dev
```

## Environment Variables

Create `.env` from `.env.example`:

```bash
# Odoo Connection
ODOO_URL=https://your-odoo.com
ODOO_DB=your_database
ODOO_USERNAME=your_username
ODOO_PASSWORD=your_api_key

# Qdrant Vector Database
QDRANT_HOST=http://localhost:6333
QDRANT_API_KEY=

# Voyage AI Embeddings
VOYAGE_API_KEY=your_api_key
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  QDRANT                                                      │
│  ├── crm_schema (23 vectors)                                │
│  │   └── Schema definitions with semantic embeddings        │
│  │                                                          │
│  └── crm_data (opportunities)                               │
│      └── Encoded strings + semantic text embeddings         │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
src/
├── index.ts                 # MCP server entry
├── types.ts                 # TypeScript interfaces
├── constants.ts             # Schema definitions (23 codes)
├── schemas/index.ts         # Zod validation
├── services/
│   ├── odoo-client.ts       # Odoo XML-RPC (with resilient retry)
│   ├── embedding-service.ts # Voyage AI
│   ├── vector-client.ts     # Qdrant
│   ├── schema-service.ts    # Schema collection
│   ├── schema-loader.ts     # Load schema from Qdrant
│   ├── data-transformer.ts  # Encode/decode with restriction handling
│   ├── data-sync.ts         # Odoo → Qdrant with streaming
│   └── sync-service.ts      # Legacy sync service
├── utils/
│   └── odoo-error-parser.ts # Parse Odoo security errors
└── tools/
    ├── vector-tools.ts      # Search & decode tools
    └── data-tool.ts         # Data sync tools
```

## Schema Codes (MVP: 23 fields)

### crm.lead (O_)
- O_1: name
- O_2: id
- O_10: expected_revenue
- O_11: probability
- O_20: description
- O_30: create_date
- O_31: write_date
- O_32: date_closed
- O_40: city
- O_41: x_sector

### res.partner (C_)
- C_1: name
- C_2: id
- C_10: email
- C_11: phone

### crm.stage (S_)
- S_1: name
- S_2: id

### res.users (U_)
- U_1: name
- U_2: id

### crm.team (T_)
- T_1: name
- T_2: id

### res.country.state (ST_)
- ST_1: name
- ST_2: id

### crm.lost.reason (LR_)
- LR_1: name

## Typical Usage Flow

1. **Discover schema**: "What fields are available for revenue?"
   → Use `vector_discover_schema` → Get O_10 (expected_revenue)

2. **Search opportunities**: "Hospital projects in Victoria"
   → Use `vector_semantic_search` → Get matching records with encoded strings

3. **Decode results**: Interpret the encoded string
   → Use `vector_decode` → Get structured data by table

4. **Keep data fresh**: Sync from Odoo
   → Use `vector_sync` with action="full_sync"

## Dynamic Model Data Sync

The `transform_data` tool supports syncing ANY Odoo model to the vector database.

**Command Format:** `transfer_[model.name]_1984`

**Examples:**
- `transfer_crm.lead_1984` → Sync CRM leads
- `transfer_res.partner_1984` → Sync contacts/partners
- `transfer_product.template_1984` → Sync products
- `transfer_sale.order_1984` → Sync sales orders

**How it works:**
1. Extracts model name from command
2. Discovers model_id and fields from schema automatically
3. Validates all fields exist in schema
4. Fetches records using streaming (memory-efficient)
5. Encodes and embeds each record
6. Uploads to vector database with `point_type: "data"`

## Graceful API Restriction Handling

When syncing certain Odoo models (e.g., `res.partner`, `product.template`), the API user may lack permission to read specific fields. Instead of failing completely, the system now handles these gracefully.

### How It Works

1. **Detection**: When Odoo returns a security error, the error message is parsed to extract restricted field names
2. **Retry**: The query is retried without the restricted fields (up to 5 attempts)
3. **Encoding**: Restricted fields are encoded as `Restricted_from_API` instead of actual values
4. **Decoding**: When decoded, restricted fields display as `[API Restricted]`

### Supported Error Patterns

**Pattern 1 - Security Restriction:**
```
The requested operation can not be completed due to security restrictions.
Document type: Contact (res.partner)
Operation: read
Fields:
- slide_channel_count (allowed for groups 'eLearning / Officer')
- slide_channel_ids (allowed for groups 'eLearning / Officer')
```

**Pattern 2 - Compute Error:**
```
ValueError: Compute method failed to assign product.template(6952,).po_ids
```

### Example Output

```
Data Sync Complete
===================
Model: res.partner
Records Processed: 1500
Records Embedded: 1500
Duration: 45.3s

API Restrictions (4 fields):
----------------------------------------
security_restriction: slide_channel_count, slide_channel_ids, slide_channel_company_count, karma

NOTE: Restricted fields are encoded as "Restricted_from_API"
in the vector database. They will decode as "[API Restricted]".
```

### Key Files

| File | Purpose |
|------|---------|
| `src/utils/odoo-error-parser.ts` | Parse Odoo security errors to extract field names |
| `src/services/odoo-client.ts` | `searchReadWithRetry()` method with automatic field fallback |
| `src/services/data-transformer.ts` | `RESTRICTED_FIELD_MARKER` constant and encoding logic |
| `src/services/data-sync.ts` | Orchestrates resilient sync with `EncodingContext` |
| `src/types.ts` | `FieldRestriction`, `EncodingContext`, `ResilientSearchResult` types |

### Deployment

Server is deployed on **Railway**. After code changes:
1. Push to git repository
2. Railway auto-deploys from main branch
3. Server restarts with new code
