/**
 * Config SDK — config extension and validation for plugins.
 */

export interface ConfigExtension {
  /** JSON Schema for the config section */
  schema: Record<string, unknown>;
  /** Default values */
  defaults: Record<string, unknown>;
  /** Validate plugin-specific config */
  validate(data: Record<string, unknown>): ConfigValidationResult;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Create a config extension with schema and defaults.
 */
export function createConfigExtension(
  schema: Record<string, unknown>,
  defaults: Record<string, unknown>,
  validate?: (data: Record<string, unknown>) => ConfigValidationResult
): ConfigExtension {
  return {
    schema,
    defaults,
    validate: validate ?? (() => ({ valid: true, errors: [], warnings: [] })),
  };
}

/**
 * Basic validator using a simple schema description.
 */
export function createValidator(
  requiredFields: string[]
): (data: Record<string, unknown>) => ConfigValidationResult {
  return (data: Record<string, unknown>) => {
    const errors: string[] = [];
    for (const field of requiredFields) {
      if (data[field] === undefined || data[field] === null) {
        errors.push(`Missing required field: ${field}`);
      }
    }
    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  };
}