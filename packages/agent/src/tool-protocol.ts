// Tool Protocol - Converts tool descriptors to protocol format for LLM consumption

import type { ToolPlanEntry } from './tool-planner.js';
import type { JsonObject, ToolDescriptor } from './tool-types.js';

/**
 * Tool protocol descriptor - format expected by LLM providers
 */
export interface ToolProtocolDescriptor {
  /** Tool name */
  name: string;
  
  /** Tool description */
  description: string;
  
  /** Input schema in JSON Schema format */
  inputSchema: Record<string, unknown>;
}

/**
 * Convert a tool plan entry to protocol format
 */
export function toToolProtocolDescriptor(entry: ToolPlanEntry): ToolProtocolDescriptor {
  return {
    name: entry.descriptor.name,
    description: entry.descriptor.description,
    inputSchema: entry.descriptor.inputSchema as unknown as Record<string, unknown>,
  };
}

/**
 * Convert multiple tool plan entries to protocol format
 */
export function toToolProtocolDescriptors(
  entries: readonly ToolPlanEntry[]
): readonly ToolProtocolDescriptor[] {
  return entries.map(toToolProtocolDescriptor);
}

/**
 * Convert a tool descriptor directly to protocol format
 */
export function descriptorToProtocol(descriptor: ToolDescriptor): ToolProtocolDescriptor {
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema as unknown as Record<string, unknown>,
  };
}

/**
 * Convert multiple tool descriptors to protocol format
 */
export function descriptorsToProtocol(
  descriptors: readonly ToolDescriptor[]
): readonly ToolProtocolDescriptor[] {
  return descriptors.map(descriptorToProtocol);
}

/**
 * Format tools for OpenAI function calling format
 */
export function toOpenAITools(
  entries: readonly ToolPlanEntry[]
): Array<Record<string, unknown>> {
  return entries.map((entry) => ({
    type: 'function',
    function: {
      name: entry.descriptor.name,
      description: entry.descriptor.description,
      parameters: entry.descriptor.inputSchema,
    },
  }));
}

/**
 * Format tools for Anthropic tool use format
 */
export function toAnthropicTools(
  entries: readonly ToolPlanEntry[]
): Array<Record<string, unknown>> {
  return entries.map((entry) => ({
    name: entry.descriptor.name,
    description: entry.descriptor.description,
    input_schema: entry.descriptor.inputSchema,
  }));
}

/**
 * Format tools for generic LLM tool format
 */
export function toGenericTools(
  entries: readonly ToolPlanEntry[],
  format: 'openai' | 'anthropic' | 'generic' = 'generic'
): Array<Record<string, unknown>> {
  switch (format) {
    case 'openai':
      return toOpenAITools(entries);
    case 'anthropic':
      return toAnthropicTools(entries);
    case 'generic':
    default:
      return toToolProtocolDescriptors(entries) as unknown as Array<Record<string, unknown>>;
  }
}

/**
 * Validate that a tool protocol descriptor has required fields
 */
export function validateToolProtocol(descriptor: ToolProtocolDescriptor): boolean {
  if (!descriptor.name || typeof descriptor.name !== 'string') {
    return false;
  }
  
  if (!descriptor.description || typeof descriptor.description !== 'string') {
    return false;
  }
  
  if (!descriptor.inputSchema || typeof descriptor.inputSchema !== 'object') {
    return false;
  }
  
  return true;
}

/**
 * Filter tool protocol descriptors by name pattern
 */
export function filterToolsByPattern(
  tools: readonly ToolProtocolDescriptor[],
  pattern: string | RegExp
): readonly ToolProtocolDescriptor[] {
  try {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    return tools.filter((tool) => regex.test(tool.name));
  } catch (err) {
    // 非法正则模式，记录到 stderr 并返回空数组（无匹配）
    process.stderr.write(
      "[ToolProtocol] invalid tool filter pattern '" + String(pattern) + "': " + err + "\n",
    );
    return [];
  }
}

/**
 * Sort tool protocol descriptors by name
 */
export function sortToolsByName(
  tools: readonly ToolProtocolDescriptor[]
): readonly ToolProtocolDescriptor[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Group tool protocol descriptors by category (based on name prefix)
 */
export function groupToolsByCategory(
  tools: readonly ToolProtocolDescriptor[]
): Record<string, ToolProtocolDescriptor[]> {
  const groups: Record<string, ToolProtocolDescriptor[]> = {};
  
  for (const tool of tools) {
    // Extract category from tool name (e.g., "file_read" -> "file")
    const category = tool.name.split('_')[0] || 'other';
    
    if (!groups[category]) {
      groups[category] = [];
    }
    
    groups[category].push(tool);
  }
  
  return groups;
}

/**
 * Generate a summary of tools for debugging
 */
export function formatToolsSummary(tools: readonly ToolProtocolDescriptor[]): string {
  if (tools.length === 0) {
    return 'No tools available';
  }
  
  const lines = [
    `Available Tools (${tools.length}):`,
    ...tools.map((tool) => `  - ${tool.name}: ${tool.description}`),
  ];
  
  return lines.join('\n');
}

/**
 * Merge tool protocol descriptors, removing duplicates by name
 * Later entries take precedence
 */
export function mergeToolProtocols(
  ...toolSets: readonly (readonly ToolProtocolDescriptor[])[]
): readonly ToolProtocolDescriptor[] {
  const toolMap = new Map<string, ToolProtocolDescriptor>();
  
  for (const tools of toolSets) {
    for (const tool of tools) {
      toolMap.set(tool.name, tool);
    }
  }
  
  return Array.from(toolMap.values());
}

/**
 * Extract tool names from protocol descriptors
 */
export function extractToolNames(
  tools: readonly ToolProtocolDescriptor[]
): readonly string[] {
  return tools.map((tool) => tool.name);
}

/**
 * Check if a tool exists in the protocol descriptors
 */
export function hasTool(
  tools: readonly ToolProtocolDescriptor[],
  name: string
): boolean {
  return tools.some((tool) => tool.name === name);
}

/**
 * Get a tool by name from protocol descriptors
 */
export function getToolByName(
  tools: readonly ToolProtocolDescriptor[],
  name: string
): ToolProtocolDescriptor | undefined {
  return tools.find((tool) => tool.name === name);
}
