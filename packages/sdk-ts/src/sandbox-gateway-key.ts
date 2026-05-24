import { DEFAULT_DASHBOARD_URL } from "./constants";

function dashboardBaseUrl(dashboardUrl?: string): string {
  return (dashboardUrl || process.env.EVOLVE_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, "");
}

async function readError(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

export async function createSandboxGatewayKey(params: {
  apiKey: string;
  dashboardUrl?: string;
  sessionTag?: string;
}): Promise<string> {
  const response = await fetch(`${dashboardBaseUrl(params.dashboardUrl)}/api/sandbox-gateway-key`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ sessionTag: params.sessionTag }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Sandbox gateway key create failed (${response.status}): ${await readError(response)}`);
  }

  const data = await response.json() as { apiKey?: unknown };
  if (typeof data.apiKey !== "string" || data.apiKey.length === 0) {
    throw new Error("Sandbox gateway key response missing apiKey");
  }
  return data.apiKey;
}
