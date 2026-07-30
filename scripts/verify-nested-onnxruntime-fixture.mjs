#!/usr/bin/env node
/**
 * OpenCode-shaped nested-install regression for #210.
 *
 * Installs the packed plugin into a temporary consumer without root overrides,
 * so @huggingface/transformers may keep nested onnxruntime-node@1.24.3.
 * Then verifies the production CJS prepare+load path pins the direct 1.22.0 stack.
 *
 * npm may hoist dependencies to the consumer root (fixture/node_modules/...) while
 * OpenCode keeps them under the plugin package. Both layouts are accepted as long as
 * transformers can resolve a nested 1.24.x copy and the production shim pins 1.22.0.
 *
 * Usage (from a built repo checkout):
 *   node scripts/verify-nested-onnxruntime-fixture.mjs
 *   bun scripts/verify-nested-onnxruntime-fixture.mjs
 *
 * Optional env:
 *   FIXTURE_DIR     — reuse an existing fixture root that already has opencode-mem installed
 *   SKIP_INSTALL    — when FIXTURE_DIR is set, skip pack/install
 *   SKIP_EMBEDDING  — skip the real feature-extraction smoke
 *   KEEP_FIXTURE    — keep the temp fixture directory
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PINNED = "1.22.0";
const NESTED_BAD = "1.24.3";
const runtime = typeof globalThis.Bun !== "undefined" ? "bun" : "node";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function log(msg) {
  console.log(`[nested-onnx-fixture] ${msg}`);
}

function fail(msg) {
  console.error(`[nested-onnx-fixture] FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (result.status !== 0) {
    fail(
      `${cmd} ${args.join(" ")} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return result.stdout;
}

function readPkgNear(entry) {
  let dir = dirname(entry);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8"));
      // onnxruntime-common ships helper package.json files under dist/* without version.
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        return { path: candidate, pkg };
      }
    }
    dir = dirname(dir);
  }
  throw new Error(`versioned package.json not found near ${entry}`);
}

function findNestedOnnxruntime(searchRoots) {
  for (const root of searchRoots) {
    const nested = join(
      root,
      "node_modules",
      "@huggingface",
      "transformers",
      "node_modules",
      "onnxruntime-node"
    );
    const pkgPath = join(nested, "package.json");
    if (existsSync(pkgPath)) {
      return {
        root: nested,
        pkg: JSON.parse(readFileSync(pkgPath, "utf8")),
      };
    }
  }
  return null;
}

function findTransformersPackageJson(searchRoots) {
  for (const root of searchRoots) {
    const candidate = join(root, "node_modules", "@huggingface", "transformers", "package.json");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  log(`runtime=${runtime} platform=${process.platform} arch=${process.arch}`);

  let fixtureDir = process.env.FIXTURE_DIR ? resolve(process.env.FIXTURE_DIR) : null;
  let cleanup = null;

  if (!fixtureDir || process.env.SKIP_INSTALL !== "1") {
    const packDir = mkdtempSync(join(tmpdir(), "opencode-mem-pack-"));
    fixtureDir = mkdtempSync(join(tmpdir(), "opencode-mem-nested-"));
    cleanup = () => {
      rmSync(packDir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    };

    log(`packing from ${repoRoot}`);
    run("npm", ["pack", "--pack-destination", packDir], repoRoot);
    const tarball = run("bash", ["-lc", `ls "${packDir}"/opencode-mem-*.tgz | head -1`]).trim();
    if (!tarball) fail("npm pack produced no tarball");

    writeFileSync(
      join(fixtureDir, "package.json"),
      JSON.stringify({ name: "opencode-mem-nested-fixture", private: true }, null, 2)
    );
    // Intentionally NO root overrides — OpenCode nested installs ignore nested overrides (#184).
    log(`installing ${tarball} into ${fixtureDir} (ignore-scripts, no overrides)`);
    run("npm", ["install", "--ignore-scripts", tarball], fixtureDir);
  }

  const pluginRoot = join(fixtureDir, "node_modules", "opencode-mem");
  if (!existsSync(pluginRoot)) fail(`plugin not installed at ${pluginRoot}`);

  const searchRoots = [pluginRoot, fixtureDir];
  const pluginRequire = createRequire(join(pluginRoot, "dist", "services", "embedding.js"));

  let directNodeEntry;
  try {
    directNodeEntry = pluginRequire.resolve("onnxruntime-node");
  } catch (error) {
    fail(`direct onnxruntime-node not resolvable from plugin: ${error}`);
  }
  const directPkg = readPkgNear(directNodeEntry).pkg;
  if (directPkg.name !== "onnxruntime-node" || directPkg.version !== PINNED) {
    fail(
      `direct onnxruntime-node is ${directPkg.name}@${directPkg.version}, expected onnxruntime-node@${PINNED}`
    );
  }
  log(`direct onnxruntime-node@${directPkg.version} at ${directNodeEntry}`);

  const nested = findNestedOnnxruntime(searchRoots);
  if (nested) {
    log(`nested onnxruntime-node@${nested.pkg.version} present under transformers`);
    if (nested.pkg.version !== NESTED_BAD && nested.pkg.version !== PINNED) {
      log(`warning: unexpected nested version ${nested.pkg.version}`);
    }
  } else {
    fail(
      "expected nested onnxruntime-node under @huggingface/transformers (OpenCode nested-install shape); package manager deduped unexpectedly"
    );
  }

  // Prove that a transformers-local require would prefer nested 1.24.x when present.
  if (nested.pkg.version !== PINNED) {
    const transformersPkg = findTransformersPackageJson(searchRoots);
    if (!transformersPkg) fail("transformers package.json not found");
    const nestedRequire = createRequire(transformersPkg);
    const nestedResolved = nestedRequire.resolve("onnxruntime-node");
    const resolvedPkg = readPkgNear(nestedResolved).pkg;
    if (resolvedPkg.version === PINNED) {
      fail(
        "expected transformers-local resolve to prefer nested 1.24.x before shim, but got pinned 1.22.0"
      );
    }
    log(`pre-shim transformers resolve -> ${nestedResolved} (@${resolvedPkg.version})`);
  }

  // Load production prepare from the installed plugin dist.
  const resolveUrl = pathToFileURL(
    join(pluginRoot, "dist", "services", "onnxruntime-resolve.js")
  ).href;
  const { prepareOnnxruntimeForTransformers, getPinnedOnnxruntimePackageRoot } =
    await import(resolveUrl);

  prepareOnnxruntimeForTransformers();

  const transformersSpecifier = ["@huggingface", "transformers"].join("/");
  const transformers = pluginRequire(transformersSpecifier);
  if (typeof transformers.pipeline !== "function" || !transformers.env) {
    fail("CJS transformers load did not expose pipeline/env");
  }

  const pinnedNode = pluginRequire.resolve("onnxruntime-node");
  const pinnedCommon = createRequire(pinnedNode).resolve("onnxruntime-common");
  const nodePkg = readPkgNear(pinnedNode).pkg;
  const commonPkg = readPkgNear(pinnedCommon).pkg;

  if (nodePkg.version !== PINNED) {
    fail(`after prepare, onnxruntime-node resolved to ${nodePkg.version} at ${pinnedNode}`);
  }
  if (commonPkg.version !== PINNED) {
    fail(
      `after prepare, onnxruntime-common resolved to ${commonPkg.version} at ${pinnedCommon}`
    );
  }

  const pinnedRoot = getPinnedOnnxruntimePackageRoot();
  if (!pinnedRoot.includes("onnxruntime-node")) {
    fail(`unexpected pinned root: ${pinnedRoot}`);
  }

  // From nested transformers context, shim must force both packages onto the pin.
  const transformersEntry = pluginRequire.resolve(transformersSpecifier);
  const fromTransformers = createRequire(transformersEntry);
  const shimmedNode = fromTransformers.resolve("onnxruntime-node");
  const shimmedCommon = fromTransformers.resolve("onnxruntime-common");
  if (readPkgNear(shimmedNode).pkg.version !== PINNED) {
    fail(`shim failed for onnxruntime-node: ${shimmedNode}`);
  }
  if (readPkgNear(shimmedCommon).pkg.version !== PINNED) {
    fail(`shim failed for onnxruntime-common: ${shimmedCommon}`);
  }

  log(`pinned node=${shimmedNode}`);
  log(`pinned common=${shimmedCommon}`);

  // Real dlopen + embedding path (optional skip for unit-speed local runs).
  if (process.env.SKIP_EMBEDDING !== "1") {
    const MODEL = "Xenova/all-MiniLM-L6-v2";
    const EXPECTED_DIMS = 384;
    transformers.env.allowLocalModels = true;
    transformers.env.allowRemoteModels = true;
    try {
      transformers.env.backends.onnx.wasm.numThreads = 1;
    } catch {
      /* wasm backend optional */
    }
    log(`loading feature-extraction pipeline for ${MODEL} ...`);
    const extractor = await transformers.pipeline("feature-extraction", MODEL);
    const out = await extractor("Hello world, nested onnxruntime fixture.", {
      pooling: "mean",
      normalize: true,
    });
    const dims = out.dims?.[out.dims.length - 1];
    if (dims !== EXPECTED_DIMS) {
      fail(`expected ${EXPECTED_DIMS} dims, got ${dims}`);
    }
    const vec = Array.from(out.data);
    const allFinite = vec.every((x) => Number.isFinite(x));
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    if (!allFinite || !(norm > 0.9 && norm < 1.1)) {
      fail(`bad embedding vector (finite=${allFinite}, norm=${norm})`);
    }
    log(`embedding ok: ${dims} dims, L2=${norm.toFixed(4)}`);
  }

  log("PASS — nested fixture loads production CJS path on onnxruntime 1.22.0 stack");

  if (cleanup && process.env.KEEP_FIXTURE !== "1") cleanup();
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack || error.message : String(error));
});
