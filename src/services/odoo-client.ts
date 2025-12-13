/**
 * Odoo XML-RPC Client (Simplified)
 *
 * A streamlined Odoo client for the vector MCP prototype.
 * Focused on read operations needed for syncing CRM data.
 *
 * Fetches data from 10 tables:
 * 1=Opportunity, 2=Contact, 3=Stage, 4=User, 5=Team,
 * 6=State, 7=LostReason, 8=Specification, 9=LeadSource, 10=Architect
 */

import xmlrpc from 'xmlrpc';
const { createClient, createSecureClient } = xmlrpc;
type Client = ReturnType<typeof createClient>;

import type { OdooConfig, CrmLead } from '../types.js';
import { ODOO_CONFIG } from '../constants.js';

// Timeout for API calls (30 seconds)
const API_TIMEOUT = 30000;

/**
 * Simple timeout wrapper for promises
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]);
}

/**
 * Odoo XML-RPC client
 */
export class OdooClient {
  private config: OdooConfig;
  private uid: number | null = null;
  private commonClient: Client;
  private objectClient: Client;

  constructor(config: OdooConfig) {
    this.config = config;

    const commonUrl = new URL('/xmlrpc/2/common', config.url);
    const objectUrl = new URL('/xmlrpc/2/object', config.url);

    const isSecure = config.url.startsWith('https');
    const clientFactory = isSecure ? createSecureClient : createClient;

    this.commonClient = clientFactory({
      host: commonUrl.hostname,
      port: isSecure ? 443 : (parseInt(commonUrl.port) || 80),
      path: commonUrl.pathname,
      headers: { 'Content-Type': 'text/xml' }
    });

    this.objectClient = clientFactory({
      host: objectUrl.hostname,
      port: isSecure ? 443 : (parseInt(objectUrl.port) || 80),
      path: objectUrl.pathname,
      headers: { 'Content-Type': 'text/xml' }
    });
  }

  /**
   * Authenticate with Odoo
   */
  async authenticate(): Promise<number> {
    if (this.uid !== null) {
      return this.uid;
    }

    const uid = await withTimeout(
      this._doAuthenticate(),
      API_TIMEOUT,
      'Odoo authentication timed out'
    );

    this.uid = uid;
    return uid;
  }

  private _doAuthenticate(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.commonClient.methodCall(
        'authenticate',
        [this.config.db, this.config.username, this.config.password, {}],
        (error: unknown, value: unknown) => {
          if (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            reject(new Error(`Authentication failed: ${errMsg}`));
          } else if (value === false) {
            reject(new Error('Authentication failed: Invalid credentials'));
          } else {
            resolve(value as number);
          }
        }
      );
    });
  }

  /**
   * Search and read records from Odoo
   */
  async searchRead<T>(
    model: string,
    domain: unknown[],
    fields: string[],
    options: { limit?: number; offset?: number; order?: string; context?: Record<string, unknown> } = {}
  ): Promise<T[]> {
    const uid = await this.authenticate();

    return withTimeout(
      this._doSearchRead<T>(uid, model, domain, fields, options),
      API_TIMEOUT,
      `Odoo search_read timed out for ${model}`
    );
  }

  private _doSearchRead<T>(
    uid: number,
    model: string,
    domain: unknown[],
    fields: string[],
    options: { limit?: number; offset?: number; order?: string; context?: Record<string, unknown> }
  ): Promise<T[]> {
    const kwargs: Record<string, unknown> = {
      fields,
      limit: options.limit,
      offset: options.offset,
      order: options.order,
    };

    // Include context with active_test for lost opportunities
    if (options.context) {
      kwargs.context = options.context;
    }

    return new Promise((resolve, reject) => {
      this.objectClient.methodCall(
        'execute_kw',
        [this.config.db, uid, this.config.password, model, 'search_read', [domain], kwargs],
        (error: unknown, value: unknown) => {
          if (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            reject(new Error(`search_read failed: ${errMsg}`));
          } else {
            resolve(value as T[]);
          }
        }
      );
    });
  }

  /**
   * Count records matching domain
   */
  async searchCount(model: string, domain: unknown[], context?: Record<string, unknown>): Promise<number> {
    const uid = await this.authenticate();

    return withTimeout(
      this._doSearchCount(uid, model, domain, context),
      API_TIMEOUT,
      `Odoo search_count timed out for ${model}`
    );
  }

  private _doSearchCount(
    uid: number,
    model: string,
    domain: unknown[],
    context?: Record<string, unknown>
  ): Promise<number> {
    const kwargs: Record<string, unknown> = {};
    if (context) {
      kwargs.context = context;
    }

    return new Promise((resolve, reject) => {
      this.objectClient.methodCall(
        'execute_kw',
        [this.config.db, uid, this.config.password, model, 'search_count', [domain], kwargs],
        (error: unknown, value: unknown) => {
          if (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            reject(new Error(`search_count failed: ${errMsg}`));
          } else {
            resolve(value as number);
          }
        }
      );
    });
  }

  /**
   * Read specific records by IDs
   */
  async read<T>(model: string, ids: number[], fields: string[]): Promise<T[]> {
    const uid = await this.authenticate();

    return withTimeout(
      this._doRead<T>(uid, model, ids, fields),
      API_TIMEOUT,
      `Odoo read timed out for ${model}`
    );
  }

  private _doRead<T>(uid: number, model: string, ids: number[], fields: string[]): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.objectClient.methodCall(
        'execute_kw',
        [this.config.db, uid, this.config.password, model, 'read', [ids], { fields }],
        (error: unknown, value: unknown) => {
          if (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            reject(new Error(`read failed: ${errMsg}`));
          } else {
            resolve(value as T[]);
          }
        }
      );
    });
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let clientInstance: OdooClient | null = null;

/**
 * Get the singleton OdooClient instance
 */
export function getOdooClient(): OdooClient {
  if (!clientInstance) {
    if (!ODOO_CONFIG.URL || !ODOO_CONFIG.DB || !ODOO_CONFIG.USERNAME || !ODOO_CONFIG.PASSWORD) {
      throw new Error('Odoo configuration incomplete. Set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD');
    }

    clientInstance = new OdooClient({
      url: ODOO_CONFIG.URL,
      db: ODOO_CONFIG.DB,
      username: ODOO_CONFIG.USERNAME,
      password: ODOO_CONFIG.PASSWORD,
    });
  }

  return clientInstance;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Fields to fetch for CRM leads
 *
 * Includes all fields from 10 tables:
 * - Core fields from crm.lead
 * - FK relations to res.partner, crm.stage, res.users, crm.team, res.country.state
 * - FK relations to crm.lost.reason
 * - Custom FK relations to x_specification, x_lead_source, x_architect (res.partner)
 */
export const LEAD_FIELDS = [
  // Core crm.lead fields (Table 1)
  'id',
  'name',
  'expected_revenue',
  'probability',
  'description',
  'create_date',
  'write_date',
  'date_closed',
  'city',
  'x_sector',
  'active',
  'is_won',

  // Standard FK relations (Tables 2-7)
  'partner_id',      // Table 2: res.partner (Contact)
  'stage_id',        // Table 3: crm.stage (Stage)
  'user_id',         // Table 4: res.users (User)
  'team_id',         // Table 5: crm.team (Team)
  'state_id',        // Table 6: res.country.state (State)
  'lost_reason_id',  // Table 7: crm.lost.reason (Lost Reason)

  // Custom FK relations (Tables 8-10)
  'x_specification_id',  // Table 8: x_specification (Specification)
  'x_lead_source_id',    // Table 9: x_lead_source (Lead Source)
  'x_architect_id',      // Table 10: res.partner (Architect)
];

/**
 * Fetch all CRM leads (opportunities) with pagination
 */
export async function fetchAllLeads(
  onProgress?: (current: number, total: number) => void
): Promise<CrmLead[]> {
  const client = getOdooClient();
  const allLeads: CrmLead[] = [];
  const batchSize = 200;

  // Include active_test: false to get lost opportunities (which have active=false)
  const context = { active_test: false };

  // Get total count first
  const total = await client.searchCount('crm.lead', [['type', '=', 'opportunity']], context);

  if (onProgress) {
    onProgress(0, total);
  }

  // Fetch in batches
  let offset = 0;
  while (offset < total) {
    const batch = await client.searchRead<CrmLead>(
      'crm.lead',
      [['type', '=', 'opportunity']],
      LEAD_FIELDS,
      { limit: batchSize, offset, order: 'id', context }
    );

    allLeads.push(...batch);
    offset += batch.length;

    if (onProgress) {
      onProgress(allLeads.length, total);
    }

    // Break if no more records
    if (batch.length < batchSize) break;
  }

  return allLeads;
}

/**
 * Fetch a single lead by ID
 */
export async function fetchLeadById(leadId: number): Promise<CrmLead | null> {
  const client = getOdooClient();
  const context = { active_test: false };

  const leads = await client.searchRead<CrmLead>(
    'crm.lead',
    [['id', '=', leadId]],
    LEAD_FIELDS,
    { limit: 1, context }
  );

  return leads.length > 0 ? leads[0] : null;
}
