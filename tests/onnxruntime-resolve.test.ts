import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import {
  assertOnnxruntimeBindingPresent,
  formatMissingOnnxruntimeBindingError,
  getOnnxruntimeBindingPath,
  getPinnedOnnxruntimePackageRoot,
  installOnnxruntimeResolveShim,
} from "../src/services/onnxruntime-resolve.js";
import pkg from "../package.json";

describe("onnxruntime resolve shim (#184)", () => {
  it("pins onnxruntime-node to the direct dependency package root", () => {
    const root = getPinnedOnnxruntimePackageRoot();
    expect(root.includes("onnxruntime-node")).toBe(true);
    const pinnedPkg = createRequire(import.meta.url)(`${root}/package.json`);
    expect(pinnedPkg.version).toBe(pkg.dependencies["onnxruntime-node"]);
  });

  it("resolve shim forces require('onnxruntime-node') onto the direct dep", () => {
    installOnnxruntimeResolveShim();
    const fromHere = createRequire(import.meta.url);
    const pinned = fromHere.resolve("onnxruntime-node");
    // Mimic nested require context under @huggingface/transformers
    const transformersPkg = fromHere.resolve("@huggingface/transformers/package.json");
    const nestedRequire = createRequire(transformersPkg);
    expect(nestedRequire.resolve("onnxruntime-node")).toBe(pinned);
  });

  it("binding path exists for the current platform (or documents the failure)", () => {
    const bindingPath = getOnnxruntimeBindingPath();
    if (existsSync(bindingPath)) {
      expect(() => assertOnnxruntimeBindingPresent()).not.toThrow();
    } else {
      expect(() => assertOnnxruntimeBindingPresent()).toThrow(
        /Local embedding native binding missing/
      );
    }
  });

  it("intel mac missing-binding message mentions remote embedding fallback", () => {
    const message = formatMissingOnnxruntimeBindingError("darwin", "x64");
    expect(message).toContain("darwin/x64");
    expect(message).toContain("embeddingApiUrl");
    expect(message).toContain("embeddingApiKey");
    expect(message).toContain("1.22.0");
  });
});
