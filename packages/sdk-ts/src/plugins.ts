import type {
  AgentPluginConfig,
  AgentType,
  SandboxCommandResult,
  SandboxInstance,
} from "./types";

const PLUGIN_INSTALL_TIMEOUT_MS = 120000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function hasString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireString(
  plugin: AgentPluginConfig,
  key: "marketplace" | "plugin" | "source",
  agentType: AgentType
): string {
  const value = (plugin as unknown as Record<string, unknown>)[key];
  if (!hasString(value)) {
    throw new Error(`withPlugins() for ${agentType} requires ${key}`);
  }
  return value;
}

function commandError(command: string, result: SandboxCommandResult): Error {
  const output = result.stderr || result.stdout || `exit code ${result.exitCode}`;
  return new Error(`Plugin setup failed while running: ${command}\n${output}`);
}

export function buildAgentPluginInstallCommands(
  agentType: AgentType,
  plugin: AgentPluginConfig
): string[] {
  switch (agentType) {
    case "droid": {
      const marketplace = requireString(plugin, "marketplace", agentType);
      const pluginName = requireString(plugin, "plugin", agentType);
      return [
        `droid plugin marketplace add ${shellQuote(marketplace)}`,
        `droid plugin install ${shellQuote(pluginName)} --scope user`,
      ];
    }

    case "claude": {
      const marketplace = requireString(plugin, "marketplace", agentType);
      const pluginName = requireString(plugin, "plugin", agentType);
      return [
        `claude plugin marketplace add ${shellQuote(marketplace)} --scope user`,
        `claude plugin install ${shellQuote(pluginName)} --scope user`,
      ];
    }

    case "gemini": {
      const source = requireString(plugin, "source", agentType);
      const geminiPlugin = plugin as unknown as Record<string, unknown>;
      const args = [`gemini extensions install ${shellQuote(source)}`];
      if (hasString(geminiPlugin.ref)) args.push(`--ref ${shellQuote(geminiPlugin.ref)}`);
      if (geminiPlugin.autoUpdate === true) args.push("--auto-update");
      if (geminiPlugin.preRelease === true) args.push("--pre-release");
      args.push("--consent");
      if (geminiPlugin.skipSettings === true) args.push("--skip-settings");
      return [args.join(" ")];
    }

    case "codex": {
      if ("plugin" in plugin) {
        throw new Error("withPlugins() for codex registers marketplaces only; codex has no plugin install command");
      }
      const marketplace = requireString(plugin, "marketplace", agentType);
      const codexPlugin = plugin as unknown as Record<string, unknown>;
      const args = [`codex plugin marketplace add ${shellQuote(marketplace)}`];
      if (hasString(codexPlugin.ref)) args.push(`--ref ${shellQuote(codexPlugin.ref)}`);
      if (Array.isArray(codexPlugin.sparse)) {
        for (const path of codexPlugin.sparse) {
          if (!hasString(path)) {
            throw new Error("withPlugins() for codex requires sparse entries to be non-empty strings");
          }
          args.push(`--sparse ${shellQuote(path)}`);
        }
      }
      return [args.join(" ")];
    }

    default:
      throw new Error(`withPlugins() is not supported for ${agentType}`);
  }
}

export async function installAgentPlugins(
  agentType: AgentType,
  sandbox: SandboxInstance,
  plugins: AgentPluginConfig[] | undefined
): Promise<void> {
  if (!plugins?.length) return;

  for (const plugin of plugins) {
    const commands = buildAgentPluginInstallCommands(agentType, plugin);
    for (const command of commands) {
      const result = await sandbox.commands.run(command, { timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS });
      if (result.exitCode !== 0) {
        throw commandError(command, result);
      }
    }
  }
}
