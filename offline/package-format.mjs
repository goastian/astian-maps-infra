import {
  createHash,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const OFFLINE_PACKAGE_SCHEMA_VERSION = 1;
export const OFFLINE_ARTIFACT_KINDS = ["map", "search", "routing"];

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function unsignedManifest(manifest) {
  const { signature: _signature, ...payload } = manifest;
  return payload;
}

export function signManifest(manifest, privateKeyPem, keyId) {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(keyId)) {
    throw new TypeError("keyId must be a stable lowercase identifier.");
  }
  const payload = Buffer.from(canonicalJson(unsignedManifest(manifest)));
  return {
    ...unsignedManifest(manifest),
    signature: {
      algorithm: "Ed25519",
      keyId,
      value: signBytes(null, payload, privateKeyPem).toString("base64"),
    },
  };
}

export function verifyManifestSignature(manifest, publicKeyPem) {
  const errors = validateOfflineManifest(manifest);
  if (errors.length > 0) return { ok: false, errors };
  const payload = Buffer.from(canonicalJson(unsignedManifest(manifest)));
  const signature = Buffer.from(manifest.signature.value, "base64");
  const ok = verifyBytes(null, payload, publicKeyPem, signature);
  return {
    ok,
    errors: ok ? [] : ["$.signature: Ed25519 verification failed"],
  };
}

export function validateOfflineManifest(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) return ["$: must be an object"];
  rejectUnknownKeys(
    manifest,
    [
      "$schema",
      "schemaVersion",
      "packageId",
      "region",
      "release",
      "artifacts",
      "totalSizeBytes",
      "signature",
    ],
    "$",
    errors,
  );
  if (manifest.$schema !== "./offline-package.schema.json") {
    errors.push("$.$schema: must reference ./offline-package.schema.json");
  }
  if (manifest.schemaVersion !== OFFLINE_PACKAGE_SCHEMA_VERSION) {
    errors.push(`$.schemaVersion: must equal ${OFFLINE_PACKAGE_SCHEMA_VERSION}`);
  }
  if (!/^[a-z0-9][a-z0-9.-]{2,79}$/.test(manifest.packageId ?? "")) {
    errors.push("$.packageId: invalid immutable package identifier");
  }
  validateRegion(manifest.region, errors);
  validateRelease(manifest.release, manifest.packageId, errors);

  if (!isPlainObject(manifest.artifacts)) {
    errors.push("$.artifacts: must be an object");
  } else {
    rejectUnknownKeys(manifest.artifacts, OFFLINE_ARTIFACT_KINDS, "$.artifacts", errors);
    for (const kind of OFFLINE_ARTIFACT_KINDS) {
      validateArtifact(kind, manifest.artifacts[kind], errors);
    }
    const computedTotal = OFFLINE_ARTIFACT_KINDS.reduce(
      (total, kind) => total + (manifest.artifacts[kind]?.sizeBytes ?? 0),
      0,
    );
    if (manifest.totalSizeBytes !== computedTotal) {
      errors.push("$.totalSizeBytes: must equal the sum of all artifact sizes");
    }
  }
  if (!Number.isSafeInteger(manifest.totalSizeBytes) || manifest.totalSizeBytes <= 0) {
    errors.push("$.totalSizeBytes: must be a positive safe integer");
  }
  validateSignature(manifest.signature, errors);
  return errors;
}

export async function sha256File(path) {
  const contents = await readFile(path);
  return createHash("sha256").update(contents).digest("hex");
}

export async function verifyOfflinePackage(manifest, packageRoot, publicKeyPem) {
  const signature = verifyManifestSignature(manifest, publicKeyPem);
  if (!signature.ok) return signature;

  const errors = [];
  for (const kind of OFFLINE_ARTIFACT_KINDS) {
    const descriptor = manifest.artifacts[kind];
    const artifactPath = safeArtifactPath(packageRoot, descriptor.path);
    if (!artifactPath) {
      errors.push(`$.artifacts.${kind}.path: escapes the package root`);
      continue;
    }
    try {
      const metadata = await lstat(artifactPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        errors.push(`$.artifacts.${kind}: artifact is not a regular file`);
        continue;
      }
      const [realRoot, realArtifact] = await Promise.all([
        realpath(packageRoot),
        realpath(artifactPath),
      ]);
      const realRelativePath = relative(realRoot, realArtifact);
      if (
        realRelativePath === "" ||
        realRelativePath === ".." ||
        realRelativePath.startsWith(`..${sep}`)
      ) {
        errors.push(`$.artifacts.${kind}.path: resolves outside the package root`);
        continue;
      }
      if (metadata.size !== descriptor.sizeBytes) {
        errors.push(`$.artifacts.${kind}.sizeBytes: expected ${descriptor.sizeBytes}, got ${metadata.size}`);
      }
      const digest = await sha256File(artifactPath);
      if (digest !== descriptor.sha256) {
        errors.push(`$.artifacts.${kind}.sha256: digest mismatch`);
      }
      await validateOfflineArtifactContents(kind, artifactPath, manifest.region);
    } catch (error) {
      errors.push(`$.artifacts.${kind}: ${error.code ?? error.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function safeArtifactPath(packageRoot, artifactPath) {
  if (typeof artifactPath !== "string" || isAbsolute(artifactPath)) return null;
  const root = resolve(packageRoot);
  const candidate = resolve(root, artifactPath);
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return null;
  return candidate;
}

export async function validateOfflineArtifactContents(kind, artifactPath, region) {
  if (!OFFLINE_ARTIFACT_KINDS.includes(kind)) {
    throw new TypeError(`Unsupported offline artifact kind: ${kind}`);
  }
  const contents = await readFile(artifactPath);
  if (kind === "map") {
    validatePmtilesV3(contents, region);
    return;
  }
  const parsed = JSON.parse(contents.toString("utf8"));
  const expectedSchema = kind === "search" ? "astian-search-v1" : "astian-routing-v1";
  if (!isPlainObject(parsed) || parsed.schema !== expectedSchema || parsed.schemaVersion !== 1) {
    throw new Error(`${kind} artifact does not implement ${expectedSchema}`);
  }
  if (parsed.regionId !== region?.id) {
    throw new Error(`${kind} artifact regionId does not match the package region`);
  }
  if (!isIsoDateTime(parsed.generatedAt)) {
    throw new Error(`${kind} artifact generatedAt is invalid`);
  }
  if (kind === "search") validateSearchArtifact(parsed, region);
  if (kind === "routing") validateRoutingArtifact(parsed, region);
}

function validateSearchArtifact(searchIndex, region) {
  if (!Array.isArray(searchIndex.places) || searchIndex.places.length === 0) {
    throw new Error("search artifact has no places");
  }
  const ids = new Set();
  for (const place of searchIndex.places) {
    if (
      !isPlainObject(place) ||
      typeof place.id !== "string" ||
      place.id.length < 3 ||
      ids.has(place.id) ||
      typeof place.name !== "string" ||
      place.name.trim().length < 1 ||
      typeof place.category !== "string" ||
      place.category.trim().length < 1 ||
      (place.normalizedName !== undefined && typeof place.normalizedName !== "string")
    ) {
      throw new Error("search artifact contains an invalid or duplicate place");
    }
    ids.add(place.id);
    validateRegionalCoordinate(place.coordinates, region, `search place ${place.id}`);
  }
}

function validateRoutingArtifact(routingGraph, region) {
  if (
    !Array.isArray(routingGraph.profiles) ||
    routingGraph.profiles.length === 0 ||
    routingGraph.profiles.some((profile) => typeof profile !== "string" || !/^[a-z][a-z0-9_-]{2,31}$/.test(profile)) ||
    new Set(routingGraph.profiles).size !== routingGraph.profiles.length
  ) {
    throw new Error("routing artifact profiles are invalid");
  }
  if (!Array.isArray(routingGraph.nodes) || routingGraph.nodes.length < 2) {
    throw new Error("routing artifact has fewer than two nodes");
  }
  const nodeIds = new Set();
  for (const node of routingGraph.nodes) {
    if (!isPlainObject(node) || typeof node.id !== "string" || node.id.length < 1 || nodeIds.has(node.id)) {
      throw new Error("routing artifact contains an invalid or duplicate node");
    }
    nodeIds.add(node.id);
    validateRegionalCoordinate(node, region, `routing node ${node.id}`);
  }
  if (!Array.isArray(routingGraph.edges) || routingGraph.edges.length === 0) {
    throw new Error("routing artifact has no traversable graph");
  }
  for (const edge of routingGraph.edges) {
    if (
      !isPlainObject(edge) ||
      typeof edge.from !== "string" ||
      typeof edge.to !== "string" ||
      edge.from === edge.to ||
      !nodeIds.has(edge.from) ||
      !nodeIds.has(edge.to) ||
      !Number.isFinite(edge.distanceMeters) ||
      edge.distanceMeters <= 0 ||
      !Number.isFinite(edge.durationSeconds) ||
      edge.durationSeconds <= 0 ||
      typeof edge.bidirectional !== "boolean"
    ) {
      throw new Error("routing artifact contains an invalid edge or unknown node reference");
    }
  }
}

function validateRegionalCoordinate(coordinate, region, label) {
  const latitude = coordinate?.latitude;
  const longitude = coordinate?.longitude;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error(`${label} has invalid WGS84 coordinates`);
  }
  if (
    Array.isArray(region?.bounds) &&
    (longitude < region.bounds[0] || longitude > region.bounds[2] || latitude < region.bounds[1] || latitude > region.bounds[3])
  ) {
    throw new Error(`${label} is outside the declared package region`);
  }
}

function validatePmtilesV3(contents, region) {
  if (contents.length < 127 || contents.subarray(0, 7).toString("ascii") !== "PMTiles") {
    throw new Error("map artifact is not a PMTiles v3 file");
  }
  if (contents[7] !== 3) throw new Error(`unsupported PMTiles version ${contents[7]}`);

  const ranges = [
    ["root directory", uint64(contents, 8), uint64(contents, 16)],
    ["JSON metadata", uint64(contents, 24), uint64(contents, 32)],
    ["leaf directories", uint64(contents, 40), uint64(contents, 48)],
    ["tile data", uint64(contents, 56), uint64(contents, 64)],
  ];
  for (const [label, offset, length] of ranges) {
    if (offset < 127 || offset + length > contents.length) {
      throw new Error(`PMTiles ${label} range exceeds the map artifact`);
    }
  }

  const addressedTiles = uint64(contents, 72);
  const tileEntries = uint64(contents, 80);
  const tileContents = uint64(contents, 88);
  if (addressedTiles < 1 || tileEntries < 1 || tileContents < 1 || ranges[3][2] < 1) {
    throw new Error("PMTiles map contains no addressable vector tiles");
  }
  if (contents[99] !== 1) {
    throw new Error(`PMTiles map must contain MVT tiles, got tile type ${contents[99]}`);
  }
  const minZoom = contents[100];
  const maxZoom = contents[101];
  if (minZoom > maxZoom || maxZoom > 24) throw new Error("PMTiles zoom range is invalid");

  const bounds = [
    contents.readInt32LE(102) / 10_000_000,
    contents.readInt32LE(106) / 10_000_000,
    contents.readInt32LE(110) / 10_000_000,
    contents.readInt32LE(114) / 10_000_000,
  ];
  const [west, south, east, north] = bounds;
  if (west >= east || south >= north || west < -180 || east > 180 || south < -90 || north > 90) {
    throw new Error("PMTiles WGS84 bounds are invalid");
  }
  if (
    Array.isArray(region?.bounds) &&
    (east < region.bounds[0] || west > region.bounds[2] || north < region.bounds[1] || south > region.bounds[3])
  ) {
    throw new Error("PMTiles bounds do not overlap the declared package region");
  }
}

function uint64(contents, offset) {
  const value = contents.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("PMTiles header contains an unsafe 64-bit offset");
  }
  return Number(value);
}

function validateRegion(region, errors) {
  if (!isPlainObject(region)) {
    errors.push("$.region: must be an object");
    return;
  }
  rejectUnknownKeys(region, ["id", "name", "bounds"], "$.region", errors);
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(region.id ?? "")) errors.push("$.region.id: invalid");
  if (typeof region.name !== "string" || region.name.trim().length < 2) errors.push("$.region.name: invalid");
  if (!Array.isArray(region.bounds) || region.bounds.length !== 4) {
    errors.push("$.region.bounds: must be [west,south,east,north]");
  } else {
    const [west, south, east, north] = region.bounds;
    if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) {
      errors.push("$.region.bounds: coordinates or ordering are invalid");
    }
    if (west < -180 || east > 180 || south < -90 || north > 90) {
      errors.push("$.region.bounds: coordinates exceed WGS84 limits");
    }
  }
}

function validateRelease(release, packageId, errors) {
  if (!isPlainObject(release)) {
    errors.push("$.release: must be an object");
    return;
  }
  rejectUnknownKeys(
    release,
    ["createdAt", "dataTimestamp", "minimumAppVersion", "rollbackPackageIds"],
    "$.release",
    errors,
  );
  for (const field of ["createdAt", "dataTimestamp"]) {
    if (!isIsoDateTime(release[field])) errors.push(`$.release.${field}: invalid ISO date-time`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(release.minimumAppVersion ?? "")) {
    errors.push("$.release.minimumAppVersion: must be semantic x.y.z");
  }
  if (
    !Array.isArray(release.rollbackPackageIds) ||
    release.rollbackPackageIds.length > 2 ||
    new Set(release.rollbackPackageIds).size !== release.rollbackPackageIds.length ||
    release.rollbackPackageIds.some(
      (id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9.-]{2,79}$/.test(id) || id === packageId,
    )
  ) {
    errors.push("$.release.rollbackPackageIds: must contain at most two unique prior package IDs");
  }
  if (
    isIsoDateTime(release.createdAt) &&
    isIsoDateTime(release.dataTimestamp) &&
    Date.parse(release.dataTimestamp) > Date.parse(release.createdAt)
  ) {
    errors.push("$.release.dataTimestamp: cannot be later than createdAt");
  }
}

function validateArtifact(kind, artifact, errors) {
  const path = `$.artifacts.${kind}`;
  if (!isPlainObject(artifact)) {
    errors.push(`${path}: is required and must be an object`);
    return;
  }
  rejectUnknownKeys(artifact, ["path", "sha256", "sizeBytes", "mediaType", "format"], path, errors);
  if (!safeRelativePath(artifact.path)) errors.push(`${path}.path: must be a safe relative path`);
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) errors.push(`${path}.sha256: invalid SHA-256`);
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) {
    errors.push(`${path}.sizeBytes: must be a positive safe integer`);
  }
  if (typeof artifact.mediaType !== "string" || !artifact.mediaType.includes("/")) {
    errors.push(`${path}.mediaType: invalid media type`);
  }
  const expectedFormat = {
    map: "pmtiles-v3",
    search: "astian-search-v1",
    routing: "astian-routing-v1",
  }[kind];
  if (artifact.format !== expectedFormat) errors.push(`${path}.format: must equal ${expectedFormat}`);
}

function validateSignature(signature, errors) {
  if (!isPlainObject(signature)) {
    errors.push("$.signature: is required and must be an object");
    return;
  }
  rejectUnknownKeys(signature, ["algorithm", "keyId", "value"], "$.signature", errors);
  if (signature.algorithm !== "Ed25519") errors.push("$.signature.algorithm: must equal Ed25519");
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(signature.keyId ?? "")) errors.push("$.signature.keyId: invalid");
  if (typeof signature.value !== "string" || !/^[A-Za-z0-9+/]{80,}={0,2}$/.test(signature.value)) {
    errors.push("$.signature.value: invalid base64 signature");
  }
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length < 3 || isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return (
    !normalized.startsWith("/") &&
    !normalized.includes(":") &&
    !normalized.includes("\0") &&
    !normalized.split("/").includes("..")
  );
}

function rejectUnknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: additional property is not allowed`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoDateTime(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
