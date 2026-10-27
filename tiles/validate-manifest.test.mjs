import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateManifest } from "./validate-manifest.mjs";

const [example, schema] = await Promise.all([
  readJson(new URL("./release-manifest.example.json", import.meta.url)),
  readJson(new URL("./release-manifest.schema.json", import.meta.url)),
]);

test("accepts the checked-in release contract", () => {
  assert.deepEqual(validateManifest(example, schema), []);
});

test("rejects unknown fields through additionalProperties false", () => {
  const manifest = structuredClone(example);
  manifest.unreviewedOrigin = "https://tiles.invalid";
  assert.match(
    validateManifest(manifest, schema).join("\n"),
    /additional properties are not allowed/,
  );
});

test("rejects malformed artifacts and self rollback", () => {
  const manifest = structuredClone(example);
  manifest.artifacts.tiles.url = "https://mutable.invalid/planet.pmtiles";
  manifest.artifacts.tiles.sizeBytes = 0;
  manifest.rollbackReleaseIds = [manifest.releaseId];
  const errors = validateManifest(manifest, schema).join("\n");
  assert.match(errors, /does not match \^s3:\/\//);
  assert.match(errors, /must be at least 1/);
  assert.match(errors, /cannot roll back to itself/);
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
