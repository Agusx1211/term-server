import { describe, expect, it } from "vitest";
import {
  CACHED_TERMINALS_LIMITS,
  clampCachedTerminals,
  describeCachedTerminals,
  parseCachedTerminals,
  resolveCachedTerminals,
} from "./cached-terminals";

describe("parseCachedTerminals", () => {
  it("treats a missing or unreadable value as no override", () => {
    expect(parseCachedTerminals(null)).toBeUndefined();
    expect(parseCachedTerminals("")).toBeUndefined();
    expect(parseCachedTerminals("   ")).toBeUndefined();
    expect(parseCachedTerminals("many")).toBeUndefined();
  });

  it("keeps zero, which is a real choice rather than an absent one", () => {
    expect(parseCachedTerminals("0")).toBe(0);
  });

  it("clamps a stored value that is out of range", () => {
    expect(parseCachedTerminals("-4")).toBe(CACHED_TERMINALS_LIMITS.min);
    expect(parseCachedTerminals("4096")).toBe(CACHED_TERMINALS_LIMITS.max);
    expect(parseCachedTerminals("12.6")).toBe(13);
  });
});

describe("resolveCachedTerminals", () => {
  it("follows the server default until the browser overrides it", () => {
    expect(resolveCachedTerminals(undefined, 16)).toBe(16);
    expect(resolveCachedTerminals(4, 16)).toBe(4);
    expect(resolveCachedTerminals(0, 16)).toBe(0);
  });

  it("clamps a server default this browser cannot honor", () => {
    expect(resolveCachedTerminals(undefined, 4096)).toBe(CACHED_TERMINALS_LIMITS.max);
  });
});

describe("describeCachedTerminals", () => {
  it("names the states a number alone does not explain", () => {
    expect(describeCachedTerminals(0)).toBe("Visible panes only");
    expect(describeCachedTerminals(1)).toBe("1 terminal");
    expect(describeCachedTerminals(16)).toBe("16 terminals");
  });
});

describe("clampCachedTerminals", () => {
  it("rounds to a whole number of renderers", () => {
    expect(clampCachedTerminals(7.4)).toBe(7);
    expect(clampCachedTerminals(7.5)).toBe(8);
  });
});
