/**
 * Force resolution of `onnxruntime-node` to this package's direct dependency.
 *
 * OpenCode installs plugins nested under its own cache. npm/Arborist only honors
 * `overrides` at the install root, so `@huggingface/transformers` would otherwise
 * keep nested `onnxruntime-node@1.24.3` (no darwin/x64 binding). See #184 / #158.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE_NAME = "onnxruntime-node";
const requireFromHere = createRequire(import.meta.url);

let shimInstalled = false;
let pinnedPackageRoot: string | null = null;

export function getPinnedOnnxruntimePackageRoot(): string {
  if (pinnedPackageRoot) return pinnedPackageRoot;
  const entry = requireFromHere.resolve(PACKAGE_NAME);
  // package entry is typically …/dist/index.js — walk up to package root
  let dir = dirname(entry);
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "package.json"))) {
      pinnedPackageRoot = dir;
      return dir;
    }
    dir = dirname(dir);
  }
  pinnedPackageRoot = dirname(entry);
  return pinnedPackageRoot;
}

export function getOnnxruntimeBindingPath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return join(
    getPinnedOnnxruntimePackageRoot(),
    "bin",
    "napi-v6",
    platform,
    arch,
    "onnxruntime_binding.node"
  );
}

export function formatMissingOnnxruntimeBindingError(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const bindingPath = getOnnxruntimeBindingPath(platform, arch);
  const intelHint =
    platform === "darwin" && arch === "x64"
      ? " On Intel Mac (darwin/x64), onnxruntime-node@1.24+ ships without an x64 binding; opencode-mem pins 1.22.0. If this persists after updating, clear OpenCode's plugin cache (~/.cache/opencode/packages/opencode-mem@*) and reinstall, or configure remote embeddings via embeddingApiUrl + embeddingApiKey."
      : " Configure remote embeddings via embeddingApiUrl + embeddingApiKey, or reinstall the plugin so onnxruntime-node@1.22.0 is used.";
  return `Local embedding native binding missing for ${platform}/${arch} at ${bindingPath}.${intelHint}`;
}

export function assertOnnxruntimeBindingPresent(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): void {
  const bindingPath = getOnnxruntimeBindingPath(platform, arch);
  if (!existsSync(bindingPath)) {
    throw new Error(formatMissingOnnxruntimeBindingError(platform, arch));
  }
}

/**
 * Patch Module._resolveFilename so require/import of "onnxruntime-node" from
 * nested transformers resolves to our direct dependency.
 */
export function installOnnxruntimeResolveShim(): void {
  if (shimInstalled) return;

  // Resolve our pin first so a missing direct dep fails before transformers loads.
  const pinnedEntry = requireFromHere.resolve(PACKAGE_NAME);

  const Module = requireFromHere("node:module") as {
    _resolveFilename: (
      request: string,
      parent: unknown,
      isMain: boolean,
      options?: unknown
    ) => string;
  };

  const original = Module._resolveFilename;
  Module._resolveFilename = function (
    request: string,
    parent: unknown,
    isMain: boolean,
    options?: unknown
  ): string {
    if (request === PACKAGE_NAME || request.startsWith(`${PACKAGE_NAME}/`)) {
      try {
        return requireFromHere.resolve(request);
      } catch {
        if (request === PACKAGE_NAME) return pinnedEntry;
      }
    }
    return original.call(this, request, parent, isMain, options);
  };

  shimInstalled = true;
}

/** Install resolve shim and fail fast if the platform binding is absent. */
export function prepareOnnxruntimeForTransformers(): void {
  installOnnxruntimeResolveShim();
  assertOnnxruntimeBindingPresent();
}
