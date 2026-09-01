import { describe, expect, it } from "vitest";
import { structurallyEqual } from "./structural-equality";

describe("structurallyEqual", () => {
  it("ignores key order", () => {
    expect(structurallyEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
  });

  it("treats absent and undefined fields as the same", () => {
    expect(structurallyEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
  });

  it("detects changed values, lengths, and shapes", () => {
    expect(structurallyEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(structurallyEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(structurallyEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(structurallyEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(structurallyEqual({ a: null }, { a: {} })).toBe(false);
  });

  it("compares primitives and null", () => {
    expect(structurallyEqual(null, null)).toBe(true);
    expect(structurallyEqual(1, 1)).toBe(true);
    expect(structurallyEqual("a", "b")).toBe(false);
    expect(structurallyEqual(null, undefined)).toBe(false);
  });
});
