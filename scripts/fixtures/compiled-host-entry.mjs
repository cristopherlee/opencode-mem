#!/usr/bin/env bun
/**
 * Minimal OpenCode-shaped Bun host entry for #210.
 *
 * OpenCode is shipped via Bun.build({ compile: { autoloadPackageJson: true, ... }})
 * and dynamically imports external plugins. This entry mimics that load path.
 *
 * Env:
 *   OPENCODE_MEM_PLUGIN_ENTRY — absolute file URL or path to embedding.js
 */
const entry = process.env.OPENCODE_MEM_PLUGIN_ENTRY;
if (!entry) {
  console.error("OPENCODE_MEM_PLUGIN_ENTRY is required");
  process.exit(1);
}

const mod = await import(entry);
if (typeof mod.loadLocalTransformersBackend !== "function") {
  console.error("plugin entry does not export loadLocalTransformersBackend");
  process.exit(1);
}

const transformers = await mod.loadLocalTransformersBackend();
if (typeof transformers.pipeline !== "function" || !transformers.env) {
  console.error("loadLocalTransformersBackend did not expose pipeline/env");
  process.exit(1);
}

const { createRequire } = await import("node:module");
const { dirname, join } = await import("node:path");
const { existsSync, readFileSync } = await import("node:fs");
const { fileURLToPath, pathToFileURL } = await import("node:url");

const entryPath = entry.startsWith("file:") ? fileURLToPath(entry) : entry;
const pluginRequire = createRequire(entryPath);
const resolveUrl = pathToFileURL(join(dirname(entryPath), "onnxruntime-resolve.js")).href;
const { getPinnedOnnxruntimePackageRoot, prepareOnnxruntimeForTransformers } =
  await import(resolveUrl);
prepareOnnxruntimeForTransformers();

function pkgVersion(entryFile) {
  let dir = dirname(entryFile);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed.version;
      }
    }
    dir = dirname(dir);
  }
  throw new Error(`versioned package.json not found near ${entryFile}`);
}

const nodeEntry = pluginRequire.resolve("onnxruntime-node");
const commonEntry = createRequire(nodeEntry).resolve("onnxruntime-common");
const nodeVersion = pkgVersion(nodeEntry);
const commonVersion = pkgVersion(commonEntry);
const pinnedRoot = getPinnedOnnxruntimePackageRoot();

if (nodeVersion !== "1.22.0") {
  console.error(`expected onnxruntime-node@1.22.0, got ${nodeVersion} at ${nodeEntry}`);
  process.exit(1);
}
if (commonVersion !== "1.22.0") {
  console.error(`expected onnxruntime-common@1.22.0, got ${commonVersion} at ${commonEntry}`);
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    nodeEntry,
    commonEntry,
    nodeVersion,
    commonVersion,
    pinnedRoot,
  })
);
