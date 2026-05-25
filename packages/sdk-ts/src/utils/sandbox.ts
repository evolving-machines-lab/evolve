/**
 * Sandbox Provider Resolution
 *
 * Resolves default sandbox provider from environment.
 * Supports E2B, Daytona, and Modal providers.
 */

import type { SandboxProvider } from "../types";
import {
  ENV_DAYTONA_API_KEY,
  ENV_E2B_API_KEY,
  ENV_EVOLVE_API_KEY,
  ENV_MODAL_TOKEN_ID,
  ENV_MODAL_TOKEN_SECRET,
  getE2BGatewayUrl,
} from "../constants";

/**
 * Resolve default sandbox provider from environment.
 *
 * Priority:
 *   1. EVOLVE_API_KEY → Through Evolve-managed gateway
 *   2. E2B_API_KEY → Direct to E2B (user's own account)
 *   3. DAYTONA_API_KEY → Direct to Daytona (user's own account)
 *   4. MODAL_TOKEN_ID + MODAL_TOKEN_SECRET → Direct to Modal (user's own account)
 *
 * This keeps the default SDK path managed by Evolve when EVOLVE_API_KEY is set.
 * Use .withSandbox(provider) to opt into BYOK sandbox billing explicitly.
 *
 * @throws Error if no provider can be resolved
 */
export async function resolveDefaultSandbox(): Promise<SandboxProvider> {
  // Gateway mode (EVOLVE_API_KEY) - recommended managed E2B
  const evolveKey = process.env[ENV_EVOLVE_API_KEY];
  if (evolveKey) {
    try {
      const { createE2BProvider } = await import("@evolvingmachines/e2b");

      // Route E2B control plane through Dashboard so Evolve can enforce
      // per-user sandbox ownership before the provider gateway injects E2B_API_KEY.
      // Keep this on the provider instance rather than process.env so later BYOK
      // E2B providers in the same process cannot inherit managed routing.
      return createE2BProvider({ apiKey: evolveKey, apiUrl: getE2BGatewayUrl() });
    } catch (e) {
      const error = e as Error;
      if (error.message?.includes("Cannot find module") || error.message?.includes("MODULE_NOT_FOUND")) {
        throw new Error(
          `${ENV_EVOLVE_API_KEY} is set but @evolvingmachines/e2b failed to load.\n` +
            "Try reinstalling: npm install @evolvingmachines/sdk"
        );
      }
      throw error;
    }
  }

  // Direct mode (E2B_API_KEY) - user's own E2B account
  const e2bKey = process.env[ENV_E2B_API_KEY];
  if (e2bKey) {
    try {
      const { createE2BProvider } = await import("@evolvingmachines/e2b");
      // Older managed-mode SDKs wrote the Dashboard E2B route into this global.
      // Direct/BYOK mode must never inherit that managed control-plane URL.
      if (process.env.E2B_API_URL === getE2BGatewayUrl()) {
        delete process.env.E2B_API_URL;
      }
      return createE2BProvider({ apiKey: e2bKey });
    } catch (e) {
      const error = e as Error;
      if (error.message?.includes("Cannot find module") || error.message?.includes("MODULE_NOT_FOUND")) {
        throw new Error(
          `${ENV_E2B_API_KEY} is set but @evolvingmachines/e2b failed to load.\n` +
            "Try reinstalling: npm install @evolvingmachines/sdk"
        );
      }
      throw error;
    }
  }

  // Direct mode (DAYTONA_API_KEY) - user's own Daytona account
  const daytonaKey = process.env[ENV_DAYTONA_API_KEY];
  if (daytonaKey) {
    try {
      const { createDaytonaProvider } = await import("@evolvingmachines/daytona");
      return createDaytonaProvider({ apiKey: daytonaKey });
    } catch (e) {
      const error = e as Error;
      if (error.message?.includes("Cannot find module") || error.message?.includes("MODULE_NOT_FOUND")) {
        throw new Error(
          `${ENV_DAYTONA_API_KEY} is set but @evolvingmachines/daytona failed to load.\n` +
            "Try installing: npm install @evolvingmachines/daytona"
        );
      }
      throw error;
    }
  }

  // Direct mode (MODAL_TOKEN_ID + MODAL_TOKEN_SECRET) - user's own Modal account
  const modalTokenId = process.env[ENV_MODAL_TOKEN_ID];
  const modalTokenSecret = process.env[ENV_MODAL_TOKEN_SECRET];
  if (modalTokenId && modalTokenSecret) {
    try {
      const { createModalProvider } = await import("@evolvingmachines/modal");
      return createModalProvider({ tokenId: modalTokenId, tokenSecret: modalTokenSecret });
    } catch (e) {
      const error = e as Error;
      if (error.message?.includes("Cannot find module") || error.message?.includes("MODULE_NOT_FOUND")) {
        throw new Error(
          `${ENV_MODAL_TOKEN_ID} is set but @evolvingmachines/modal failed to load.\n` +
            "Try installing: npm install @evolvingmachines/modal"
        );
      }
      throw error;
    }
  }

  throw new Error(
    "No sandbox provider configured. Either:\n" +
      `1. Set ${ENV_EVOLVE_API_KEY} environment variable (recommended, get key at https://dashboard.evolvingmachines.ai)\n` +
      `2. Set ${ENV_E2B_API_KEY} environment variable (direct E2B access, get key at https://e2b.dev)\n` +
      `3. Set ${ENV_DAYTONA_API_KEY} environment variable (direct Daytona access, get key at https://app.daytona.io)\n` +
      `4. Set ${ENV_MODAL_TOKEN_ID} and ${ENV_MODAL_TOKEN_SECRET} environment variables (direct Modal access, get tokens at https://modal.com/settings/tokens)\n` +
      "5. Pass sandbox explicitly: .withSandbox(provider)"
  );
}
