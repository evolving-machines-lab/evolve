/**
 * Sandbox Provider Resolution
 *
 * Resolves default sandbox provider from environment.
 * Currently supports E2B as the default provider.
 */

import type { SandboxProvider } from "../types";
import { ENV_E2B_API_KEY, ENV_EVOLVE_API_KEY, ENV_MODAL_TOKEN_ID, ENV_MODAL_TOKEN_SECRET, getE2BGatewayUrl } from "../constants";

/**
 * Resolve default sandbox provider from environment.
 *
 * Priority (gateway first for observability & billing):
 *   1. EVOLVE_API_KEY → Through gateway (recommended)
 *   2. E2B_API_KEY → Direct to E2B (power users with own key)
 *
 * @throws Error if no provider can be resolved
 */
export async function resolveDefaultSandbox(): Promise<SandboxProvider> {
  // Gateway mode (EVOLVE_API_KEY) - preferred for observability & billing
  const evolveKey = process.env[ENV_EVOLVE_API_KEY];
  if (evolveKey) {
    try {
      const { createE2BProvider } = await import("@evolvingmachines/e2b");

      // Route E2B control plane through gateway
      // Note: Sandbox.list() only reads apiUrl from env var (not from options),
      // so this is the only way to ensure all operations go through gateway
      process.env.E2B_API_URL = getE2BGatewayUrl();

      return createE2BProvider({ apiKey: evolveKey });
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

  // Direct mode (E2B_API_KEY) - for power users with their own E2B account
  const e2bKey = process.env[ENV_E2B_API_KEY];
  if (e2bKey) {
    try {
      const { createE2BProvider } = await import("@evolvingmachines/e2b");
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

  // Direct mode (MODAL_TOKEN_ID + MODAL_TOKEN_SECRET) - Modal provider
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
      `3. Set ${ENV_MODAL_TOKEN_ID} and ${ENV_MODAL_TOKEN_SECRET} environment variables (Modal access)\n` +
      "4. Pass sandbox explicitly: .withSandbox(provider)"
  );
}
