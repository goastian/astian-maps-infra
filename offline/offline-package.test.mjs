import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { buildOfflinePackage } from "./build-package.mjs";
import {
  canonicalJson,
  sha256File,
  signManifest,
  validateOfflineManifest,
  verifyOfflinePackage,
  verifyManifestSignature,
} from "./package-format.mjs";
import { openOfflineRegion, routeOffline, searchOffline } from "./offline-runtime.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("builds, signs, verifies and opens a map/search/routing regional package", async () => {
  await withPackage(async ({ manifest, outputRoot, publicKey }) => {
    assert.deepEqual(validateOfflineManifest(manifest), []);
    assert.equal(verifyManifestSignature(manifest, publicKey).ok, true);
    assert.deepEqual(await verifyOfflinePackage(manifest, outputRoot, publicKey), {
      ok: true,
      errors: [],
    });

    const region = await openOfflineRegion(manifest, outputRoot, publicKey);
    assert.equal(searchOffline(region.searchIndex, "casino")[0].id, "offline:monaco:casino");
    const route = routeOffline(region.routingGraph, {
      profile: "walking",
      waypoints: [
        { latitude: 43.731278, longitude: 7.420833 },
        { latitude: 43.739722, longitude: 7.427222 },
      ],
    });
    assert.deepEqual(route.snappedWaypointIds, ["palace", "casino"]);
    assert.equal(route.distanceMeters, 1260);
    assert.ok(route.geometry.length >= 3);
  });
});

test("rejects manifest tampering before reading package files", async () => {
  await withPackage(async ({ manifest, outputRoot, publicKey }) => {
    const tampered = structuredClone(manifest);
    tampered.region.name = "Another region";
    const result = await verifyOfflinePackage(tampered, outputRoot, publicKey);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Ed25519 verification failed/);
  });
});

test("rejects artifact tampering and traversal paths", async () => {
  await withPackage(async ({ manifest, outputRoot, publicKey, privateKey, keyId }) => {
    await writeFile(resolve(outputRoot, manifest.artifacts.search.path), "{}\n");
    const tamperedArtifact = await verifyOfflinePackage(manifest, outputRoot, publicKey);
    assert.equal(tamperedArtifact.ok, false);
    assert.match(tamperedArtifact.errors.join("\n"), /sizeBytes|digest mismatch/);

    const traversal = structuredClone(manifest);
    traversal.artifacts.search.path = "../outside.json";
    delete traversal.signature;
    const signedTraversal = signManifest(traversal, privateKey, keyId);
    assert.match(validateOfflineManifest(signedTraversal).join("\n"), /safe relative path/);

    const windowsDrive = structuredClone(manifest);
    windowsDrive.artifacts.search.path = "C:/outside.json";
    delete windowsDrive.signature;
    assert.match(
      validateOfflineManifest(signManifest(windowsDrive, privateKey, keyId)).join("\n"),
      /safe relative path/,
    );

    const selfRollback = structuredClone(manifest);
    selfRollback.release.rollbackPackageIds = [selfRollback.packageId];
    delete selfRollback.signature;
    assert.match(
      validateOfflineManifest(signManifest(selfRollback, privateKey, keyId)).join("\n"),
      /unique prior package IDs/,
    );
  });
});

test("rejects a signed PMTiles shell without addressable map content", async () => {
  await withPackage(async ({ manifest, outputRoot, publicKey, privateKey, keyId }) => {
    const mapPath = resolve(outputRoot, manifest.artifacts.map.path);
    const mapContents = Buffer.from(await readFile(mapPath));
    mapContents.writeBigUInt64LE(0n, 88);
    await writeFile(mapPath, mapContents);

    const unsigned = structuredClone(manifest);
    delete unsigned.signature;
    unsigned.artifacts.map.sha256 = await sha256File(mapPath);
    const signed = signManifest(unsigned, privateKey, keyId);
    const result = await verifyOfflinePackage(signed, outputRoot, publicKey);

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /no addressable vector tiles/);
  });
});

test("rejects signed search and routing artifacts that do not match their declared region", async () => {
  await withPackage(async ({ manifest, outputRoot, publicKey, privateKey, keyId }) => {
    const searchPath = resolve(outputRoot, manifest.artifacts.search.path);
    const searchIndex = JSON.parse(await readFile(searchPath, "utf8"));
    searchIndex.regionId = "colombia";
    await writeFile(searchPath, `${JSON.stringify(searchIndex)}\n`);

    const unsignedSearch = structuredClone(manifest);
    delete unsignedSearch.signature;
    unsignedSearch.artifacts.search.sizeBytes = (await stat(searchPath)).size;
    unsignedSearch.artifacts.search.sha256 = await sha256File(searchPath);
    unsignedSearch.totalSizeBytes = Object.values(unsignedSearch.artifacts)
      .reduce((total, artifact) => total + artifact.sizeBytes, 0);
    const searchResult = await verifyOfflinePackage(
      signManifest(unsignedSearch, privateKey, keyId),
      outputRoot,
      publicKey,
    );
    assert.equal(searchResult.ok, false);
    assert.match(searchResult.errors.join("\n"), /regionId does not match/);

    const routingPath = resolve(outputRoot, manifest.artifacts.routing.path);
    const routingGraph = JSON.parse(await readFile(routingPath, "utf8"));
    routingGraph.edges[0].to = "missing-node";
    await writeFile(routingPath, `${JSON.stringify(routingGraph)}\n`);
    const unsignedRouting = structuredClone(manifest);
    delete unsignedRouting.signature;
    unsignedRouting.artifacts.search = unsignedSearch.artifacts.search;
    unsignedRouting.artifacts.routing.sizeBytes = (await stat(routingPath)).size;
    unsignedRouting.artifacts.routing.sha256 = await sha256File(routingPath);
    unsignedRouting.totalSizeBytes = Object.values(unsignedRouting.artifacts)
      .reduce((total, artifact) => total + artifact.sizeBytes, 0);
    const routingResult = await verifyOfflinePackage(
      signManifest(unsignedRouting, privateKey, keyId),
      outputRoot,
      publicKey,
    );
    assert.equal(routingResult.ok, false);
    assert.match(routingResult.errors.join("\n"), /unknown node reference/);
  });
});

test("builder refuses malformed regional source data before writing a signed manifest", async () => {
  await withPackage(async ({ buildOptions, temporaryRoot }) => {
    const invalidSearchPath = resolve(temporaryRoot, "wrong-region-search.json");
    const searchIndex = JSON.parse(await readFile(buildOptions.searchPath, "utf8"));
    searchIndex.regionId = "colombia";
    await writeFile(invalidSearchPath, `${JSON.stringify(searchIndex)}\n`);

    await assert.rejects(
      buildOfflinePackage({
        ...buildOptions,
        searchPath: invalidSearchPath,
        outputRoot: resolve(temporaryRoot, "invalid-package"),
      }),
      /regionId does not match the package region/,
    );
  });
});

test("canonical JSON is deterministic across object insertion order", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(canonicalJson({ z: 1, "$schema": 2, A: 3, a: 4 }), '{"$schema":2,"A":3,"a":4,"z":1}');
});

async function withPackage(assertions) {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "astian-offline-test-"));
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const privateKeyPath = resolve(temporaryRoot, "private.pem");
    await writeFile(privateKeyPath, privateKey, { mode: 0o600 });
    const outputRoot = resolve(temporaryRoot, "package");
    await mkdir(dirname(outputRoot), { recursive: true });
    const buildOptions = {
      packageId: "monaco.2026-07-29.test",
      regionId: "monaco",
      regionName: "Monaco",
      bounds: [7.409, 43.724, 7.44, 43.755],
      mapPath: resolve(repositoryRoot, "data/tiles/planet.pmtiles"),
      searchPath: resolve(repositoryRoot, "infra/offline/fixtures/monaco/search-index.json"),
      routingPath: resolve(repositoryRoot, "infra/offline/fixtures/monaco/routing-graph.json"),
      privateKeyPath,
      keyId: "test-2026-01",
      outputRoot,
      createdAt: "2026-07-29T00:00:00Z",
      dataTimestamp: "2026-07-18T00:00:00Z",
      rollbackPackageIds: [],
    };
    const result = await buildOfflinePackage(buildOptions);
    await assertions({
      ...result,
      manifest: JSON.parse(await readFile(result.manifestPath, "utf8")),
      publicKey,
      privateKey,
      keyId: "test-2026-01",
      buildOptions,
      temporaryRoot,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
