/**
 * Sandbox Provider Resolution
 *
 * Resolves default sandbox provider from environment.
 * Supports E2B, Daytona, and Modal providers.
 */

import type { SandboxCreateOptions, SandboxProvider } from "../types";
import {
  ENV_DAYTONA_API_KEY,
  ENV_E2B_API_KEY,
  ENV_EVOLVE_API_KEY,
  ENV_MODAL_TOKEN_ID,
  ENV_MODAL_TOKEN_SECRET,
  getE2BGatewayUrl,
  getManagedDaytonaToolboxUrl,
  getManagedProviderUrl,
  MANAGED_SANDBOX_PROVIDERS,
  type ManagedSandboxProviderName,
} from "../constants";

/**
 * Encode an Evolve gateway key as an e2b-shaped key for the managed E2B route.
 *
 * The upstream e2b client validates `apiKey` against /^e2b_[0-9a-f]+$/ before
 * sending any request, so the raw `sk-…` Evolve key can no longer ride in
 * directly. Hex wrapping satisfies the client; the Dashboard managed route
 * decodes it back.
 */
export function toManagedE2BKey(evolveKey: string): string {
  return `e2b_${Buffer.from(evolveKey, "utf8").toString("hex")}`;
}

const evolveManagedSandboxProviders = new WeakSet<SandboxProvider>();

function markEvolveManagedSandbox(provider: SandboxProvider): SandboxProvider {
  evolveManagedSandboxProviders.add(provider);
  return provider;
}

export function isEvolveManagedSandboxProvider(provider: SandboxProvider): boolean {
  return evolveManagedSandboxProviders.has(provider);
}

function missingProviderPackage(pkg: string, install: string): Error {
  return new Error(
    `${ENV_EVOLVE_API_KEY} is set but ${pkg} failed to load.\n` + `Try installing: ${install}`,
  );
}

function isMissingModule(error: Error): boolean {
  return (
    error.message?.includes("Cannot find module") || error.message?.includes("MODULE_NOT_FOUND")
  );
}

/**
 * Sandbox-shape defaults a managed provider applies to every sandbox it
 * creates. Per-create options (`.withSandboxCreateOptions()`) still win, and
 * the values ride the same validated path as any create: providers and doors
 * reject what they cannot enforce, never silently ignore it.
 */
export interface ManagedSandboxCreateDefaults {
  /** Lifetime cap (ms) for every sandbox this provider creates. */
  timeoutMs?: number;
  /** Compute sizing (cpu cores, memory/disk GiB) for every create. */
  resources?: SandboxCreateOptions["resources"];
}

/** Options bag for `managedSandbox()`: the Evolve key plus create defaults. */
export interface ManagedSandboxOptions extends ManagedSandboxCreateDefaults {
  /** Evolve API key. Default: the EVOLVE_API_KEY environment variable. */
  apiKey?: string;
}

/**
 * Fold the managed-level defaults under every create. The provider's own
 * validation still runs on the merged options, so a default the backing
 * provider cannot enforce (`resources` through a platform-sized door) is
 * refused at create time exactly as if the caller had passed it there.
 */
function withCreateDefaults(
  provider: SandboxProvider,
  defaults?: ManagedSandboxCreateDefaults,
): SandboxProvider {
  if (!defaults || (defaults.timeoutMs === undefined && defaults.resources === undefined)) {
    return provider;
  }
  const createDirect = provider.create.bind(provider);
  provider.create = (options: SandboxCreateOptions = {}) =>
    createDirect({
      ...(defaults.timeoutMs !== undefined ? { timeoutMs: defaults.timeoutMs } : {}),
      ...(defaults.resources !== undefined ? { resources: defaults.resources } : {}),
      ...options,
    });
  return provider;
}

/**
 * Resolve a sandbox provider that runs on the platform's credentials.
 *
 * The caller holds one Evolve API key and no provider credential. Which
 * provider backs the sandbox is a choice, not an environment accident, so it
 * is an argument here and a value on the public `managedSandbox()` helper —
 * never an env var.
 */
export async function resolveManagedSandbox(
  evolveKey?: string,
  provider: ManagedSandboxProviderName = "e2b",
  defaults?: ManagedSandboxCreateDefaults,
): Promise<SandboxProvider> {
  const apiKey = evolveKey || process.env[ENV_EVOLVE_API_KEY];
  if (!apiKey) {
    throw new Error(`${ENV_EVOLVE_API_KEY} is required for Evolve-managed sandbox features`);
  }
  if (!MANAGED_SANDBOX_PROVIDERS.includes(provider)) {
    throw new Error(
      `Unknown managed sandbox provider "${provider}". ` +
        `Supported: ${MANAGED_SANDBOX_PROVIDERS.join(", ")}`,
    );
  }

  if (provider === "daytona") {
    try {
      const { createDaytonaProvider } = await import("@evolvingmachines/daytona");
      // Both planes ride the Dashboard: apiUrl for create/list/delete, and
      // managedToolboxUrl for every command and file operation, which Daytona
      // would otherwise send straight to a runner host this process holds no
      // credential for. The Evolve key travels as the Daytona apiKey because
      // that is the header the Daytona client puts it in and the header both
      // managed doors read.
      return withCreateDefaults(
        markEvolveManagedSandbox(
          createDaytonaProvider({
            apiKey,
            apiUrl: getManagedProviderUrl("daytona"),
            managedToolboxUrl: getManagedDaytonaToolboxUrl(),
          }),
        ),
        defaults,
      );
    } catch (e) {
      const error = e as Error;
      if (isMissingModule(error)) {
        throw missingProviderPackage(
          "@evolvingmachines/daytona",
          "npm install @evolvingmachines/daytona",
        );
      }
      throw error;
    }
  }

  if (provider === "modal") {
    // Modal's control plane is gRPC/protobuf (nice-grpc against api.modal.com;
    // the client honors MODAL_SERVER_URL, so the URL itself CAN move) — but a
    // door at that URL would have to serve Modal's private protobuf schema,
    // method by method, forever tracking it. Rejected on cost, not mechanics:
    // managed Modal is instead the door's own HTTP client (see
    // utils/managed-modal.ts for the wire, which the Dashboard's twin routes
    // are built against).
    const { ManagedModalProvider } = await import("./managed-modal");
    return withCreateDefaults(
      markEvolveManagedSandbox(
        new ManagedModalProvider({ apiKey, baseUrl: getManagedProviderUrl("modal") }),
      ),
      defaults,
    );
  }

  try {
    const { createE2BProvider } = await import("@evolvingmachines/e2b");
    return withCreateDefaults(
      markEvolveManagedSandbox(
        createE2BProvider({ apiKey: toManagedE2BKey(apiKey), apiUrl: getE2BGatewayUrl() }),
      ),
      defaults,
    );
  } catch (e) {
    const error = e as Error;
    if (isMissingModule(error)) {
      throw missingProviderPackage(
        "@evolvingmachines/e2b",
        "npm install @evolvingmachines/sdk",
      );
    }
    throw error;
  }
}

/**
 * A sandbox the platform runs for you.
 *
 * ```ts
 * const kit = new Evolve()
 *   .withAgent({ agentType: "claude" })
 *   .withSandbox(await managedSandbox("daytona", { timeoutMs: 7_200_000 }));
 * ```
 *
 * Requires an Evolve API key and no provider credential of any kind. Omit the
 * provider to take the platform default (E2B). The options bag carries the
 * Evolve key plus sandbox-shape defaults (`timeoutMs`, `resources`) applied to
 * every create; a bare string is still accepted as the key alone.
 */
export function managedSandbox(
  provider: ManagedSandboxProviderName = "e2b",
  options?: string | ManagedSandboxOptions,
): Promise<SandboxProvider> {
  const bag = typeof options === "string" ? { apiKey: options } : options ?? {};
  const { apiKey, ...defaults } = bag;
  return resolveManagedSandbox(apiKey, provider, defaults);
}

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

  // Gateway mode (EVOLVE_API_KEY) - fallback to gateway E2B
  const evolveKey = process.env[ENV_EVOLVE_API_KEY];
  if (evolveKey) {
    return resolveManagedSandbox(evolveKey);
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
