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

import type {
  OdooConfig,
  CrmLead,
  ResilientSearchResult,
  ResilientSearchConfig,
  FieldRestrictionReason,
} from '../types.js';
import { ODOO_CONFIG } from '../constants.js';
import {
  parseOdooError,
  isFieldRestrictionError,
  isSingletonError,
} from '../utils/odoo-error-parser.js';

// Timeout for API calls (2 minutes - needed for large batch operations with many fields)
const API_TIMEOUT = 120000;

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

  /**
   * Search and read with automatic retry on field restriction errors
   *
   * When Odoo returns security restriction or compute errors for specific fields,
   * this method automatically:
   * 1. Parses the error to extract restricted field names
   * 2. Removes those fields from the request
   * 3. Retries the request (up to maxRetries times)
   * 4. Returns both the records AND the list of restricted fields
   *
   * @param model - Odoo model name (e.g., 'res.partner')
   * @param domain - Search domain filters
   * @param fields - Fields to fetch (will be reduced if restrictions found)
   * @param options - Standard searchRead options (limit, offset, order, context)
   * @param config - Retry configuration
   * @returns Records and metadata about restricted fields
   */
  async searchReadWithRetry<T>(
    model: string,
    domain: unknown[],
    fields: string[],
    options: { limit?: number; offset?: number; order?: string; context?: Record<string, unknown> } = {},
    config: ResilientSearchConfig = {}
  ): Promise<ResilientSearchResult<T>> {
    const maxRetries = config.maxRetries ?? 5;
    const onFieldRestricted = config.onFieldRestricted;

    let currentFields = [...fields];
    const restrictedFields: string[] = [];
    const warnings: string[] = [];
    let retryCount = 0;

    while (retryCount <= maxRetries) {
      try {
        // Attempt the search_read
        const records = await this.searchRead<T>(model, domain, currentFields, options);

        // Success! Return results
        return {
          records,
          restrictedFields,
          retryCount,
          warnings,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check if this is a field restriction error we can handle
        if (!isFieldRestrictionError(errorMessage)) {
          // Not a field restriction error - re-throw
          throw error;
        }

        // Parse the error to extract restricted field names
        const parsed = parseOdooError(errorMessage);

        // Handle singleton errors with INDIVIDUAL field testing
        // Singleton errors don't tell us which field caused the problem
        // We test each field individually with a safe base ['id'] to find ALL problematic fields
        if (parsed.type === 'singleton_error' && parsed.restrictedFields.length === 0) {
          console.error(`[${model}] Singleton error detected - testing fields individually`);
          warnings.push(`Singleton error in ${model} - testing each field individually`);

          // Test each field individually against a safe base
          const safeFields: string[] = ['id']; // 'id' is always safe
          const problematicFields: string[] = [];

          // Test each non-id field individually
          for (const fieldToTest of currentFields) {
            if (fieldToTest === 'id') continue; // Skip id, it's our safe base

            try {
              // Test this field with 'id' and limit=2 (need 2+ records to trigger singleton bugs)
              // Singleton errors only occur when self has multiple records, not with 1 record
              const testOptions = { ...options, limit: 2 };
              await this.searchRead<T>(model, domain, ['id', fieldToTest], testOptions);

              // Success - this field is safe
              safeFields.push(fieldToTest);
            } catch (testError) {
              const testMsg = testError instanceof Error ? testError.message : String(testError);

              if (isSingletonError(testMsg)) {
                // This field causes singleton error
                problematicFields.push(fieldToTest);

                const warning = `[${model}] Field '${fieldToTest}' causes singleton error (odoo_error)`;
                warnings.push(warning);
                console.error(warning);

                // Notify callback
                if (onFieldRestricted) {
                  onFieldRestricted(fieldToTest, 'odoo_error');
                }
              } else {
                // Different error - assume field is safe but log warning
                safeFields.push(fieldToTest);
                warnings.push(`[${model}] Field '${fieldToTest}' had non-singleton error: ${testMsg.slice(0, 100)}`);
              }
            }
          }

          if (problematicFields.length === 0) {
            // No individual field caused the error - might be a combination issue
            warnings.push(`Could not identify problematic fields through individual testing`);
            throw error;
          }

          // Update state with all problematic fields found
          restrictedFields.push(...problematicFields);
          currentFields = safeFields;

          console.error(`[${model}] Found ${problematicFields.length} problematic field(s): ${problematicFields.join(', ')}`);
          console.error(`[${model}] Continuing with ${safeFields.length} safe fields`);

          // Retry with safe fields only
          retryCount++;
          continue; // Go back to main while loop to retry
        }

        // Standard handling for errors with known field names
        if (parsed.restrictedFields.length === 0) {
          // Couldn't extract field names - re-throw original error
          warnings.push(`Could not parse restricted fields from error: ${errorMessage}`);
          throw error;
        }

        // Determine restriction reason
        const reason: FieldRestrictionReason = parsed.type === 'compute_error'
          ? 'compute_error'
          : parsed.type === 'security_restriction'
            ? 'security_restriction'
            : 'unknown';

        // Remove restricted fields and retry
        for (const fieldName of parsed.restrictedFields) {
          if (currentFields.includes(fieldName)) {
            currentFields = currentFields.filter(f => f !== fieldName);
            restrictedFields.push(fieldName);

            const warning = `[${model}] Field '${fieldName}' restricted (${reason}) - removed from query`;
            warnings.push(warning);
            console.error(warning);

            // Notify callback if provided
            if (onFieldRestricted) {
              onFieldRestricted(fieldName, reason);
            }
          }
        }

        // Check if we have any fields left
        if (currentFields.length === 0) {
          throw new Error(`All fields are restricted for model ${model}. Cannot proceed with sync.`);
        }

        retryCount++;

        if (retryCount > maxRetries) {
          throw new Error(
            `Max retries (${maxRetries}) exceeded for ${model}. ` +
            `Restricted fields: ${restrictedFields.join(', ')}`
          );
        }

        // Continue to next iteration with reduced field list
        console.error(`[${model}] Retrying with ${currentFields.length} fields (attempt ${retryCount}/${maxRetries})`);
      }
    }

    // Should not reach here, but TypeScript needs this
    throw new Error(`Unexpected end of retry loop for ${model}`);
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
  'active',

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
