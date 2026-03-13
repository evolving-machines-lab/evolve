/**
 * Sandbox Provider Resolution
 *
 * Resolves default sandbox provider from environment.
 * Supports E2B, Daytona, and Modal providers.
 */

import type { SandboxProvider } from "../types";
import {
  ENV_DAYTONA_API_KEY,
  ENV_DOCKER_SANDBOX,
  ENV_E2B_API_KEY,
  ENV_EVOLVE_API_KEY,
  ENV_LOCAL_SANDBOX,
  ENV_MICROVM_SANDBOX,
  ENV_MODAL_TOKEN_ID,
  ENV_MODAL_TOKEN_SECRET,
  ENV_OS_SANDBOX,
  getE2BGatewayUrl,
} from "../constants";

/**
 * Resolve default sandbox provider from environment.
 *
 * Priority (user's sandbox keys first, gateway as fallback):
 *   1. E2B_API_KEY → Direct to E2B (user's own account)
 *   2. DAYTONA_API_KEY → Direct to Daytona (user's own account)
 *   3. MODAL_TOKEN_ID + MODAL_TOKEN_SECRET → Direct to Modal (user's own account)
 *   4. EVOLVE_API_KEY → Through gateway (fallback)
 *
 * This allows users to set both EVOLVE_API_KEY (for model routing + dashboard)
 * and their own sandbox key (E2B_API_KEY, DAYTONA_API_KEY, or Modal tokens) to control
 * sandbox billing separately.
 *
 * @throws Error if no provider can be resolved
 */
export async function resolveDefaultSandbox(): Promise<SandboxProvider> {
  // Direct mode (E2B_API_KEY) - user's own E2B account
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

  // Local Docker mode (EVOLVE_SANDBOX_DOCKER) - no API key needed
  const useDocker = process.env[ENV_DOCKER_SANDBOX];
  if (useDocker === "1" || useDocker === "true") {
    try {
      const { createDockerProvider } = await import("@evolvingmachines/docker");
      return createDockerProvider();
    } catch (e) {
      const error = e as Error;
      if (error.message?.includes("Cannot find module") || error.message?.includes("MODULE_NOT_FOUND")) {
        throw new Error(
          `${ENV_DOCKER_SANDBOX} is set but @evolvingmachines/docker failed to load.\n` +
            "Try installing: npm install @evolvingmachines/docker"
        );
      }
      throw error;
    }
  }

  // MicroVM mode (EVOLVE_SANDBOX_MICROVM) - lightweight VM via Boxlite
  const useMicroVM = process.env[ENV_MICROVM_SANDBOX];
  if (useMicroVM === "1" || useMicroVM === "true") {
    try {
      const { createMicroVMProvider } = await import("@evolvingmachines/microvm");
      return createMicroVMProvider();
    } catch (e) {
      const error = e as Error;
      if (error.message?.includes("Cannot find module") || error.message?.includes("MODULE_NOT_FOUND")) {
        throw new Error(
          `${ENV_MICROVM_SANDBOX} is set but @evolvingmachines/microvm failed to load.\n` +
            "Try installing: npm install @evolvingmachines/microvm"
        );
      }
      throw error;
    }
  }

  // OS-level sandbox mode (EVOLVE_SANDBOX_OS) - kernel-enforced isolation
  const useOSSandbox = process.env[ENV_OS_SANDBOX];
  if (useOSSandbox === "1" || useOSSandbox === "true") {
    try {
      const { createOSSandboxProvider } = await import("@evolvingmachines/sandbox");
      return createOSSandboxProvider();
    } catch (e) {
      const error = e as Error;
      if (error.message?.includes("Cannot find module") || error.message?.includes("MODULE_NOT_FOUND")) {
        throw new Error(
          `${ENV_OS_SANDBOX} is set but @evolvingmachines/sandbox failed to load.\n` +
            "Try installing: npm install @evolvingmachines/sandbox"
        );
      }
      throw error;
    }
  }

  // Local subprocess mode (EVOLVE_SANDBOX_LOCAL) - no isolation, direct execution
  const useLocal = process.env[ENV_LOCAL_SANDBOX];
  if (useLocal === "1" || useLocal === "true") {
    try {
      const { createLocalProvider } = await import("@evolvingmachines/local");
      return createLocalProvider();
    } catch (e) {
      const error = e as Error;
      if (error.message?.includes("Cannot find module") || error.message?.includes("MODULE_NOT_FOUND")) {
        throw new Error(
          `${ENV_LOCAL_SANDBOX} is set but @evolvingmachines/local failed to load.\n` +
            "Try installing: npm install @evolvingmachines/local"
        );
      }
      throw error;
    }
  }

  // Gateway mode (EVOLVE_API_KEY) - fallback to gateway E2B
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

  throw new Error(
    "No sandbox provider configured. Either:\n" +
      `1. Set ${ENV_EVOLVE_API_KEY} environment variable (recommended, get key at https://dashboard.evolvingmachines.ai)\n` +
      `2. Set ${ENV_E2B_API_KEY} environment variable (direct E2B access, get key at https://e2b.dev)\n` +
      `3. Set ${ENV_DAYTONA_API_KEY} environment variable (direct Daytona access, get key at https://app.daytona.io)\n` +
      `4. Set ${ENV_MODAL_TOKEN_ID} and ${ENV_MODAL_TOKEN_SECRET} environment variables (direct Modal access, get tokens at https://modal.com/settings/tokens)\n` +
      `5. Set ${ENV_DOCKER_SANDBOX}=true for local Docker sandbox (requires Docker)\n` +
      `6. Set ${ENV_MICROVM_SANDBOX}=true for MicroVM sandbox (requires Boxlite, macOS ARM64 / Linux)\n` +
      `7. Set ${ENV_OS_SANDBOX}=true for OS-level sandbox (macOS Seatbelt / Linux bubblewrap)\n` +
      `8. Set ${ENV_LOCAL_SANDBOX}=true for local subprocess execution (no isolation)\n` +
      "9. Pass sandbox explicitly: .withSandbox(provider)"
  );
}
