/**
 * Administrator-declared MCP tool exposure and effect class.
 * Remote MCP annotations are untrusted; only this catalogue decides readOnly.
 */
export interface McpAllowedTool {
  name: string;
  /** When true, authorizeAction may return allow; mutating stays suppressed until write adapters exist. */
  readOnly: boolean;
}

/** Stored jsonb may be legacy `string[]` or structured entries. */
export type McpToolAllowlistJson = (string | McpAllowedTool)[] | null;

export function normalizeMcpAllowlist(value: unknown): McpAllowedTool[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const byName = new Map<string, McpAllowedTool>();
  for (const entry of value) {
    if (typeof entry === 'string') {
      const name = entry.trim();
      if (!name || byName.has(name)) continue;
      // Legacy string allowlists predate effect classification — keep mutating.
      byName.set(name, { name, readOnly: false });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { name?: unknown; readOnly?: unknown };
    if (typeof record.name !== 'string') continue;
    const name = record.name.trim();
    if (!name) continue;
    byName.set(name, { name, readOnly: record.readOnly === true });
  }
  const tools = [...byName.values()];
  return tools.length ? tools : null;
}

export function mcpToolIsReadOnly(
  allowlist: McpAllowedTool[] | null | undefined,
  toolName: string,
): boolean {
  return allowlist?.find((tool) => tool.name === toolName)?.readOnly === true;
}
