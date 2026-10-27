import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("Usage: node infra/tiles/validate-manifest.mjs <manifest.json>");
    process.exit(2);
  }

  const [manifest, schema] = await Promise.all([
    readJson(manifestPath),
    readJson(new URL("./release-manifest.schema.json", import.meta.url)),
  ]);
  const errors = validateManifest(manifest, schema);

  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }

  console.log(`Validated geodata release ${manifest.releaseId}.`);
}

export function validateManifest(manifest, schema) {
  const errors = validateSchema(manifest, schema, schema);
  if (
    Array.isArray(manifest?.rollbackReleaseIds) &&
    manifest.rollbackReleaseIds.includes(manifest.releaseId)
  ) {
    errors.push("$.rollbackReleaseIds: a release cannot roll back to itself");
  }
  return errors;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    console.error(`Cannot read valid JSON from ${String(path)}: ${error.message}`);
    process.exit(2);
  }
}

/**
 * Validate the deliberately small JSON Schema vocabulary used by the release
 * contract. Keeping this local makes the promotion gate usable before pnpm is
 * installed while the schema remains the single structural source of truth.
 */
function validateSchema(value, currentSchema, rootSchema, path = "$") {
  if (currentSchema.$ref) {
    return validateSchema(
      value,
      resolveLocalReference(rootSchema, currentSchema.$ref),
      rootSchema,
      path,
    );
  }

  const errors = [];
  if (Object.hasOwn(currentSchema, "const") && value !== currentSchema.const) {
    errors.push(`${path}: must equal ${JSON.stringify(currentSchema.const)}`);
    return errors;
  }

  if (currentSchema.type && !matchesType(value, currentSchema.type)) {
    errors.push(`${path}: must be ${currentSchema.type}`);
    return errors;
  }

  if (currentSchema.type === "object") {
    const properties = currentSchema.properties ?? {};
    for (const required of currentSchema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        errors.push(`${path}.${required}: is required`);
      }
    }
    if (currentSchema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          errors.push(`${path}.${key}: additional properties are not allowed`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        errors.push(
          ...validateSchema(value[key], propertySchema, rootSchema, `${path}.${key}`),
        );
      }
    }
  }

  if (currentSchema.type === "array") {
    if (currentSchema.maxItems !== undefined && value.length > currentSchema.maxItems) {
      errors.push(`${path}: must contain at most ${currentSchema.maxItems} items`);
    }
    if (currentSchema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) {
        errors.push(`${path}: items must be unique`);
      }
    }
    if (currentSchema.items) {
      value.forEach((item, index) => {
        errors.push(
          ...validateSchema(item, currentSchema.items, rootSchema, `${path}[${index}]`),
        );
      });
    }
  }

  if (currentSchema.type === "string") {
    if (currentSchema.minLength !== undefined && value.length < currentSchema.minLength) {
      errors.push(`${path}: must contain at least ${currentSchema.minLength} characters`);
    }
    if (currentSchema.pattern && !new RegExp(currentSchema.pattern).test(value)) {
      errors.push(`${path}: does not match ${currentSchema.pattern}`);
    }
    if (currentSchema.format === "date-time" && !isIsoDateTime(value)) {
      errors.push(`${path}: must be an ISO 8601 date-time with timezone`);
    }
  }

  if (currentSchema.type === "integer") {
    if (currentSchema.minimum !== undefined && value < currentSchema.minimum) {
      errors.push(`${path}: must be at least ${currentSchema.minimum}`);
    }
  }

  return errors;
}

function resolveLocalReference(schema, reference) {
  if (!reference.startsWith("#/")) {
    throw new Error(`Only local JSON Schema references are supported: ${reference}`);
  }
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, key) => value[key], schema);
}

function matchesType(value, type) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isSafeInteger(value);
  return typeof value === type;
}

function isIsoDateTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}
