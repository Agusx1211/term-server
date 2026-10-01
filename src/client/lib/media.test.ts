import { describe, expect, it } from "vitest";
import { formatMediaDuration, mediaKindOf } from "./media";

describe("mediaKindOf", () => {
  const file = { image: false, audio: false, video: false };

  it("names the preview a file gets", () => {
    expect(mediaKindOf({ ...file, image: true })).toBe("image");
    expect(mediaKindOf({ ...file, video: true })).toBe("video");
    expect(mediaKindOf({ ...file, audio: true })).toBe("audio");
  });

  it("has no preview for anything else, including servers that predate media", () => {
    expect(mediaKindOf(file)).toBeUndefined();
    expect(mediaKindOf({ image: false })).toBeUndefined();
  });
});

describe("formatMediaDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatMediaDuration(0)).toBe("0:00");
    expect(formatMediaDuration(7.4)).toBe("0:07");
    expect(formatMediaDuration(65)).toBe("1:05");
    expect(formatMediaDuration(3725)).toBe("1:02:05");
  });

  it("has nothing to show for a stream without a length", () => {
    expect(formatMediaDuration(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(formatMediaDuration(Number.NaN)).toBeUndefined();
  });
});
