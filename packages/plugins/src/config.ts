import { parse as parseYaml } from "yaml";
import type { PluginRegistration } from "./index.js";

export interface ParsedPluginConfig {
  registrations: PluginRegistration[];
  blockedReason?: string;
}

interface RawConfig {
  plugins?: {
    allowUnsandboxedPlugins?: boolean;
    load?: Array<{ package?: string; config?: Record<string, string | undefined> }>;
  };
}

export function parsePluginConfig(yamlText: string): ParsedPluginConfig {
  if (!yamlText || yamlText.trim() === "") {
    return { registrations: [] };
  }
  const raw = (parseYaml(yamlText) ?? {}) as RawConfig;
  const block = raw.plugins;
  if (!block || !Array.isArray(block.load) || block.load.length === 0) {
    return { registrations: [] };
  }
  if (block.allowUnsandboxedPlugins !== true) {
    return { registrations: [], blockedReason: "allowUnsandboxedPlugins not set" };
  }
  const registrations: PluginRegistration[] = [];
  for (const item of block.load) {
    if (!item || typeof item.package !== "string") continue;
    registrations.push({ type: "package", packageName: item.package, config: item.config ?? {} });
  }
  return { registrations };
}
