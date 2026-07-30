/**
 * Force resolution of `onnxruntime-node` (and its `onnxruntime-common`) to this
 * package's direct dependency stack.
 *
 * OpenCode installs plugins nested under its own cache. npm/Arborist only honors
 * `overrides` at the install root, so `@huggingface/transformers` would otherwise
 * keep nested `onnxruntime-node@1.24.3` (no darwin/x64 binding). See #184 / #158 / #210.
 *
 * Transformers must be loaded via its CJS export so this Module._resolveFilename
 * shim applies; the ESM entry's static `import "onnxruntime-node"` bypasses it.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE_NAME = "onnxruntime-node";
const COMMON_PACKAGE = "onnxruntime-common";
const requireFromHere = createRequire(import.meta.url);

let shimInstalled = false;
let pinnedPackageRoot: string | null = null;
let pinnedNodeEntry: string | null = null;
let pinnedCommonEntry: string | null = null;

function getPinnedOnnxruntimeEntry(): string {
  if (pinnedNodeEntry) return pinnedNodeEntry;
  pinnedNodeEntry = requireFromHere.resolve(PACKAGE_NAME);
  return pinnedNodeEntry;
}

function getPinnedOnnxruntimeCommonEntry(): string {
  if (pinnedCommonEntry) return pinnedCommonEntry;
  // Resolve common from the pinned node package so we always get the 1.22.0 stack,
  // whether the package manager hoists it or nests it under onnxruntime-node.
  pinnedCommonEntry = createRequire(getPinnedOnnxruntimeEntry()).resolve(COMMON_PACKAGE);
  return pinnedCommonEntry;
}

export function getPinnedOnnxruntimePackageRoot(): string {
  if (pinnedPackageRoot) return pinnedPackageRoot;
  const entry = getPinnedOnnxruntimeEntry();
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

/**
 * Rewrite onnxruntime-related init failures.
 *
 * When the pinned binding is absent, keep the clear "missing" message.
 * When it is present, preserve the original error so nested-1.24 / dlopen /
 * codesign failures are not misreported as a missing 1.22.0 file (#210).
 */
export function formatOnnxruntimeInitError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const isOnnxRelated =
    message.includes("onnxruntime_binding.node") ||
    message.includes("onnxruntime-node") ||
    message.includes("onnxruntime-common") ||
    /napi-v6\/[^/]+\/[^/]+/.test(message);

  if (!isOnnxRelated) {
    return error instanceof Error ? error : new Error(message);
  }

  const bindingPath = getOnnxruntimeBindingPath(platform, arch);
  if (!existsSync(bindingPath)) {
    return new Error(formatMissingOnnxruntimeBindingError(platform, arch), { cause: error });
  }

  const intelHint =
    platform === "darwin" && arch === "x64"
      ? " On Intel Mac nested installs, @huggingface/transformers may resolve onnxruntime-node@1.24+ (no x64 binding); opencode-mem pins 1.22.0 via a CJS resolve shim."
      : "";

  return new Error(
    `ONNX runtime failed to load despite pinned binding being present at ${bindingPath}. Original error: ${message}.${intelHint} If this persists after updating, clear OpenCode's plugin cache (~/.cache/opencode/packages/opencode-mem@*) and reinstall, or configure remote embeddings via embeddingApiUrl + embeddingApiKey.`,
    { cause: error }
  );
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

function resolvePinnedRequest(
  request: string,
  packageName: string,
  pinnedEntry: string
): string | null {
  if (request !== packageName && !request.startsWith(`${packageName}/`)) {
    return null;
  }
  try {
    if (packageName === PACKAGE_NAME) {
      return requireFromHere.resolve(request);
    }
    return createRequire(getPinnedOnnxruntimeEntry()).resolve(request);
  } catch {
    if (request === packageName) return pinnedEntry;
    return null;
  }
}

/**
 * Patch Module._resolveFilename so require() of onnxruntime-node / onnxruntime-common
 * from nested transformers resolves to our direct 1.22.0 dependency stack.
 */
export function installOnnxruntimeResolveShim(): void {
  if (shimInstalled) return;

  // Resolve our pin first so a missing direct dep fails before transformers loads.
  const pinnedEntry = getPinnedOnnxruntimeEntry();
  const pinnedCommon = getPinnedOnnxruntimeCommonEntry();

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
    const pinnedNode = resolvePinnedRequest(request, PACKAGE_NAME, pinnedEntry);
    if (pinnedNode) return pinnedNode;

    const pinnedCommonResolved = resolvePinnedRequest(request, COMMON_PACKAGE, pinnedCommon);
    if (pinnedCommonResolved) return pinnedCommonResolved;

    return original.call(this, request, parent, isMain, options);
  };

  shimInstalled = true;
}

/** Install resolve shim and fail fast if the platform binding is absent. */
export function prepareOnnxruntimeForTransformers(): void {
  installOnnxruntimeResolveShim();
  assertOnnxruntimeBindingPresent();
}
