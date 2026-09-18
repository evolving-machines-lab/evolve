/**
 * The org a run names is proven BEFORE the run: the ingest refuses a wrong
 * org 404 per batch, and a refused batch is a trace nobody ever sees.
 */

import { getDashboardUrl } from "../constants";
import { EvolveApiError, orgs } from "../hosted";
import { EvolveConfigError } from "../utils/config";

/** Resolves when `org` exists and the key's user is a member; a 404 is the caller's mistake, typed as one. */
export async function requireOrgMembership(org: string, apiKey: string): Promise<void> {
  try {
    await orgs({ apiKey, baseUrl: getDashboardUrl() }).get(org);
  } catch (error) {
    if (error instanceof EvolveApiError && error.status === 404) {
      throw new EvolveConfigError(
        "org",
        `Organization ${JSON.stringify(org)} was not found, or you are not a member of it ` +
          `(${error.code}). Check the slug or id passed as org; the session would otherwise ` +
          "be refused by the dashboard and its trace lost.",
      );
    }
    throw error;
  }
}
