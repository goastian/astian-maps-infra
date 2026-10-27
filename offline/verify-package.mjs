import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyOfflinePackage } from "./package-format.mjs";

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const manifestPath = process.argv[2];
  const publicKeyPath = process.argv[3];
  const explicitRoot = process.argv[4];
  if (!manifestPath || !publicKeyPath) {
    console.error("Usage: node infra/offline/verify-package.mjs <manifest.json> <public-key.pem> [package-root]");
    process.exit(2);
  }
  try {
    const [manifest, publicKeyPem] = await Promise.all([
      readFile(manifestPath, "utf8").then(JSON.parse),
      readFile(publicKeyPath, "utf8"),
    ]);
    const result = await verifyOfflinePackage(
      manifest,
      explicitRoot ? resolve(explicitRoot) : dirname(resolve(manifestPath)),
      publicKeyPem,
    );
    if (!result.ok) {
      console.error(`Offline package verification failed:\n${result.errors.map((error) => `- ${error}`).join("\n")}`);
      process.exit(1);
    }
    console.log(`Verified offline package ${manifest.packageId}: signature and 3 artifacts are valid.`);
  } catch (error) {
    console.error(`Cannot verify offline package: ${error.message}`);
    process.exit(2);
  }
}
