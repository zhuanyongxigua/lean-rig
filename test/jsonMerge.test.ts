import { describe, it, expect } from "vitest";
import { deepMerge } from "../src/core/jsonMerge.js";

describe("deepMerge", () => {
  it("merges top-level keys", () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("recursively merges nested objects", () => {
    const result = deepMerge(
      { outer: { a: 1, b: 2 } },
      { outer: { b: 99, c: 3 } }
    );
    expect(result).toEqual({ outer: { a: 1, b: 99, c: 3 } });
  });

  it("replaces arrays entirely (not merges)", () => {
    const result = deepMerge({ arr: [1, 2, 3] }, { arr: [4, 5] });
    expect(result).toEqual({ arr: [4, 5] });
  });

  it("replaces scalar with array", () => {
    const result = deepMerge({ x: 1 }, { x: [1, 2] });
    expect(result).toEqual({ x: [1, 2] });
  });

  it("sets null on key when patch has null", () => {
    const result = deepMerge({ a: { nested: "val" } }, { a: null });
    expect(result).toEqual({ a: null });
  });

  it("does not mutate base or patch", () => {
    const base = { a: { x: 1 } };
    const patch = { a: { y: 2 } };
    const result = deepMerge(base, patch);
    expect(base).toEqual({ a: { x: 1 } });
    expect(patch).toEqual({ a: { y: 2 } });
    expect(result).toEqual({ a: { x: 1, y: 2 } });
  });

  it("adds new keys from patch that do not exist in base", () => {
    const result = deepMerge({}, { newKey: "value" });
    expect(result).toEqual({ newKey: "value" });
  });

  it("handles deeply nested merge", () => {
    const result = deepMerge(
      { l1: { l2: { l3: { a: 1, b: 2 } } } },
      { l1: { l2: { l3: { b: 99, c: 3 } } } }
    );
    expect(result).toEqual({ l1: { l2: { l3: { a: 1, b: 99, c: 3 } } } });
  });
});
