import { readFile, mkdir, copyFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  sha256File,
  signManifest,
  validateOfflineArtifactContents,
  validateOfflineManifest,
} from "./package-format.mjs";

export async function buildOfflinePackage(options) {
  const outputRoot = resolve(options.outputRoot);
  await mkdir(outputRoot, { recursive: true });
  await copyFile(
    resolve(import.meta.dirname, "offline-package.schema.json"),
    resolve(outputRoot, "offline-package.schema.json"),
  );
  const region = {
    id: options.regionId,
    name: options.regionName,
    bounds: options.bounds,
  };
  const artifactSpecs = {
    map: {
      source: resolve(options.mapPath),
      path: `map/${basename(options.mapPath)}`,
      mediaType: "application/vnd.pmtiles",
      format: "pmtiles-v3",
    },
    search: {
      source: resolve(options.searchPath),
      path: `search/${basename(options.searchPath)}`,
      mediaType: "application/json",
      format: "astian-search-v1",
    },
    routing: {
      source: resolve(options.routingPath),
      path: `routing/${basename(options.routingPath)}`,
      mediaType: "application/json",
      format: "astian-routing-v1",
    },
  };

  const artifacts = {};
  for (const [kind, spec] of Object.entries(artifactSpecs)) {
    const target = resolve(outputRoot, spec.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(spec.source, target);
    await validateOfflineArtifactContents(kind, target, region);
    const metadata = await stat(target);
    artifacts[kind] = {
      path: spec.path,
      sha256: await sha256File(target),
      sizeBytes: metadata.size,
      mediaType: spec.mediaType,
      format: spec.format,
    };
  }

  const unsigned = {
    $schema: "./offline-package.schema.json",
    schemaVersion: 1,
    packageId: options.packageId,
    region,
    release: {
      createdAt: options.createdAt,
      dataTimestamp: options.dataTimestamp,
      minimumAppVersion: options.minimumAppVersion ?? "0.2.0",
      rollbackPackageIds: options.rollbackPackageIds ?? [],
    },
    artifacts,
    totalSizeBytes: Object.values(artifacts).reduce((total, item) => total + item.sizeBytes, 0),
  };
  const privateKeyPem = await readFile(options.privateKeyPath, "utf8");
  const manifest = signManifest(unsigned, privateKeyPem, options.keyId);
  const manifestErrors = validateOfflineManifest(manifest);
  if (manifestErrors.length > 0) {
    throw new TypeError(`Offline package manifest is invalid: ${manifestErrors.join("; ")}`);
  }
  const manifestPath = resolve(outputRoot, "package-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return { manifest, manifestPath, outputRoot };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2));
  const required = [
    "package-id",
    "region-id",
    "region-name",
    "bounds",
    "map",
    "search",
    "routing",
    "private-key",
    "key-id",
    "output",
    "created-at",
    "data-timestamp",
  ];
  const missing = required.filter((key) => !args[key]);
  if (missing.length > 0) {
    console.error(`Missing required options: ${missing.map((key) => `--${key}`).join(", ")}`);
    process.exit(2);
  }
  const bounds = args.bounds.split(",").map(Number);
  if (bounds.length !== 4 || bounds.some((value) => !Number.isFinite(value))) {
    console.error("--bounds must be west,south,east,north");
    process.exit(2);
  }
  const result = await buildOfflinePackage({
    packageId: args["package-id"],
    regionId: args["region-id"],
    regionName: args["region-name"],
    bounds,
    mapPath: args.map,
    searchPath: args.search,
    routingPath: args.routing,
    privateKeyPath: args["private-key"],
    keyId: args["key-id"],
    outputRoot: args.output,
    createdAt: args["created-at"],
    dataTimestamp: args["data-timestamp"],
    minimumAppVersion: args["minimum-app-version"] ?? "0.2.0",
    rollbackPackageIds: args.rollback ? args.rollback.split(",").filter(Boolean) : [],
  });
  console.log(`Built and signed offline package ${result.manifest.packageId} at ${result.outputRoot}.`);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      console.error(`Invalid argument near ${key ?? "end of command"}.`);
      process.exit(2);
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}
