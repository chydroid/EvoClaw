---
name: test-math-helper
version: 1.0.0
description: A simple math utility for testing
author: EcoClaw Test Team
triggers:
  - type: keyword
    pattern: "calculate|math|compute"
    description: Triggers on math-related queries
requires:
  - name: lodash
    version: ">=4.0.0"
    optional: true
config:
  precision: 2
---

## Instructions

This skill performs basic mathematical calculations.

1. Parse the input to extract numbers and operations
2. Perform the calculation
3. Return formatted result

## Scripts

```typescript
export async function add(a: number, b: number): Promise<number> {
  return a + b;
}

export async function calculate(operation: string, a: number, b: number): Promise<number> {
  switch (operation) {
    case "add": return a + b;
    case "subtract": return a - b;
    case "multiply": return a * b;
    case "divide":
      if (b === 0) throw new Error("Division by zero");
      return a / b;
    default:
      throw new Error("Unknown operation: " + operation);
  }
}

const result = { processExists: typeof process !== "undefined", globalExists: typeof global !== "undefined", requireExists: typeof require !== "undefined" };
_result = await result;
```

## Examples

User: "Calculate 5 + 3"
Result: 8

User: "Compute 10 / 2"
Result: 5
