// Tool Planner - Deterministic planner for descriptor-backed tools
// Plans usable tools from descriptors, availability, and request constraints

import type { ToolDescriptor, ToolExecutor } from './tool-types.js';
import {
  evaluateToolAvailability,
  type ToolAvailabilityContext,
  type ToolAvailabilityDiagnostic,
} from './tool-availability.js';

/**
 * A visible tool entry in the plan
 */
export interface ToolPlanEntry {
  descriptor: ToolDescriptor;
  executor: ToolExecutor;
}

/**
 * A hidden tool entry with diagnostic information
 */
export interface HiddenToolPlanEntry {
  descriptor: ToolDescriptor;
  diagnostics: readonly ToolAvailabilityDiagnostic[];
}

/**
 * The complete tool plan
 */
export interface ToolPlan {
  visible: readonly ToolPlanEntry[];
  hidden: readonly HiddenToolPlanEntry[];
}

/**
 * Options for building a tool plan
 */
export interface BuildToolPlanOptions {
  descriptors: readonly ToolDescriptor[];
  availability?: ToolAvailabilityContext;
}

/**
 * Error thrown when tool plan contracts are violated
 */
export class ToolPlanContractError extends Error {
  constructor(
    public readonly code: string,
    public readonly toolName: string,
    message: string
  ) {
    super(message);
    this.name = 'ToolPlanContractError';
  }
}

/**
 * Compare two tool descriptors for sorting
 * Sorts by sortKey first, then by name
 */
function compareDescriptors(left: ToolDescriptor, right: ToolDescriptor): number {
  const leftKey = left.sortKey ?? left.name;
  const rightKey = right.sortKey ?? right.name;
  
  const keyComparison = leftKey.localeCompare(rightKey);
  if (keyComparison !== 0) {
    return keyComparison;
  }
  
  return left.name.localeCompare(right.name);
}

/**
 * Assert that all tool descriptor names are unique
 * @throws ToolPlanContractError if duplicate names are found
 */
function assertUniqueNames(descriptors: readonly ToolDescriptor[]): void {
  const seen = new Set<string>();
  
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.name)) {
      throw new ToolPlanContractError(
        'duplicate-tool-name',
        descriptor.name,
        `Duplicate tool descriptor name: ${descriptor.name}`
      );
    }
    seen.add(descriptor.name);
  }
}

/**
 * Build the visible and hidden tool plan for a runtime context
 * 
 * This function:
 * 1. Sorts descriptors deterministically
 * 2. Validates unique names
 * 3. Evaluates availability for each descriptor
 * 4. Separates tools into visible (available) and hidden (unavailable)
 * 5. Validates that visible tools have executors
 * 
 * @param options - Plan building options
 * @returns The complete tool plan with visible and hidden entries
 * 
 * @example
 * ```typescript
 * const plan = buildToolPlan({
 *   descriptors: [
 *     {
 *       name: 'web-search',
 *       description: 'Search the web',
 *       availability: { kind: 'env', name: 'SEARCH_API_KEY' },
 *       executor: webSearchExecutor
 *     },
 *     {
 *       name: 'file-read',
 *       description: 'Read a file',
 *       availability: { kind: 'always' },
 *       executor: fileReadExecutor
 *     }
 *   ],
 *   availability: {
 *     env: { SEARCH_API_KEY: '...' }
 *   }
 * });
 * 
 * process.stdout.write(`Visible tools: ${plan.visible.length}`);
 * process.stdout.write(`Hidden tools: ${plan.hidden.length}`);
 * ```
 */
export function buildToolPlan(options: BuildToolPlanOptions): ToolPlan {
  // Sort descriptors deterministically
  const descriptors = [...options.descriptors].sort(compareDescriptors);
  
  // Validate unique names
  assertUniqueNames(descriptors);
  
  const visible: ToolPlanEntry[] = [];
  const hidden: HiddenToolPlanEntry[] = [];
  
  for (const descriptor of descriptors) {
    // Evaluate availability
    const diagnostics = evaluateToolAvailability({
      availability: descriptor.availability ?? { kind: 'always' },
      context: options.availability,
    });
    
    if (diagnostics.length > 0) {
      // Tool is unavailable - add to hidden list with diagnostics
      hidden.push({ descriptor, diagnostics });
      continue;
    }
    
    // Tool is available - validate it has an executor
    if (!descriptor.executor) {
      throw new ToolPlanContractError(
        'missing-executor',
        descriptor.name,
        `Visible tool descriptor has no executor ref: ${descriptor.name}`
      );
    }
    
    // Add to visible list
    visible.push({
      descriptor,
      executor: descriptor.executor,
    });
  }
  
  return { visible, hidden };
}

/**
 * Get only the visible tool names from a plan
 */
export function getVisibleToolNames(plan: ToolPlan): readonly string[] {
  return plan.visible.map((entry) => entry.descriptor.name);
}

/**
 * Get only the hidden tool names from a plan
 */
export function getHiddenToolNames(plan: ToolPlan): readonly string[] {
  return plan.hidden.map((entry) => entry.descriptor.name);
}

/**
 * Find a visible tool by name
 */
export function findVisibleTool(
  plan: ToolPlan,
  name: string
): ToolPlanEntry | undefined {
  return plan.visible.find((entry) => entry.descriptor.name === name);
}

/**
 * Get diagnostic information for a hidden tool
 */
export function getHiddenToolDiagnostics(
  plan: ToolPlan,
  name: string
): readonly ToolAvailabilityDiagnostic[] | undefined {
  return plan.hidden.find((entry) => entry.descriptor.name === name)?.diagnostics;
}

/**
 * Format a tool plan summary for debugging
 */
export function formatToolPlanSummary(plan: ToolPlan): string {
  const visibleNames = getVisibleToolNames(plan).join(', ') || '(none)';
  const hiddenNames = getHiddenToolNames(plan).join(', ') || '(none)';
  
  return [
    `Tool Plan Summary:`,
    `  Visible tools (${plan.visible.length}): ${visibleNames}`,
    `  Hidden tools (${plan.hidden.length}): ${hiddenNames}`,
  ].join('\n');
}

/**
 * Filter a tool plan by tool names
 */
export function filterToolPlan(
  plan: ToolPlan,
  allowedNames: readonly string[]
): ToolPlan {
  const allowedSet = new Set(allowedNames);
  
  return {
    visible: plan.visible.filter((entry) => allowedSet.has(entry.descriptor.name)),
    hidden: plan.hidden.filter((entry) => allowedSet.has(entry.descriptor.name)),
  };
}

/**
 * Merge multiple tool plans
 * Later plans take precedence for duplicate tool names
 */
export function mergeToolPlans(plans: readonly ToolPlan[]): ToolPlan {
  const visibleMap = new Map<string, ToolPlanEntry>();
  const hiddenMap = new Map<string, HiddenToolPlanEntry>();
  
  for (const plan of plans) {
    for (const entry of plan.visible) {
      visibleMap.set(entry.descriptor.name, entry);
      hiddenMap.delete(entry.descriptor.name); // Remove from hidden if it was there
    }
    
    for (const entry of plan.hidden) {
      if (!visibleMap.has(entry.descriptor.name)) {
        hiddenMap.set(entry.descriptor.name, entry);
      }
    }
  }
  
  return {
    visible: Array.from(visibleMap.values()),
    hidden: Array.from(hiddenMap.values()),
  };
}
