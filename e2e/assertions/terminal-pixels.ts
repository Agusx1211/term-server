import { inflateSync } from "node:zlib";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

export interface PixelClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TerminalPixelImage {
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly clip: PixelClip;
}

export interface PixelAnalysis {
  readonly width: number;
  readonly height: number;
  readonly nonBackgroundPixels: number;
  readonly nonBackgroundRatio: number;
  readonly uniqueColorCount: number;
  readonly dominantColorPixels: number;
  readonly dominantColor: readonly [number, number, number, number];
}

export interface NonBlankOptions {
  readonly minimumNonBackgroundRatio?: number;
  readonly colorDistance?: number;
  readonly maxSingleColorPixels?: number;
  readonly testInfo?: TestInfo;
  readonly artifactName?: string;
}

export interface ChangedPixelOptions {
  readonly colorDistance?: number;
  readonly minimumChangedRatio?: number;
  readonly testInfo?: TestInfo;
  readonly artifactName?: string;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const paeth = (left: number, above: number, upperLeft: number): number => {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
};

const pixelDistance = (
  firstData: Uint8Array,
  first: number,
  secondData: Uint8Array,
  second: number,
): number => Math.max(
  Math.abs(firstData[first]! - secondData[second]!),
  Math.abs(firstData[first + 1]! - secondData[second + 1]!),
  Math.abs(firstData[first + 2]! - secondData[second + 2]!),
  Math.abs(firstData[first + 3]! - secondData[second + 3]!),
);

function decodePng(buffer: Buffer, clip: PixelClip): TerminalPixelImage {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error("Screenshot is not a PNG");
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    if (payloadEnd + 4 > buffer.length) throw new Error("Truncated screenshot PNG");
    if (type === "IHDR") {
      width = buffer.readUInt32BE(payloadStart);
      height = buffer.readUInt32BE(payloadStart + 4);
      bitDepth = buffer[payloadStart + 8]!;
      colorType = buffer[payloadStart + 9]!;
      interlace = buffer[payloadStart + 12]!;
    } else if (type === "IDAT") {
      idat.push(buffer.subarray(payloadStart, payloadEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = payloadEnd + 4;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0) {
    throw new Error("Unsupported screenshot PNG format");
  }
  const sourceBytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (!sourceBytesPerPixel) throw new Error(`Unsupported screenshot PNG color type ${colorType}`);
  const sourceRowLength = width * sourceBytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idat));
  const source = new Uint8Array(height * sourceRowLength);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset++]!;
    const rowStart = y * sourceRowLength;
    const previousRowStart = rowStart - sourceRowLength;
    for (let x = 0; x < sourceRowLength; x += 1) {
      const raw = inflated[inputOffset++]!;
      const left = x >= sourceBytesPerPixel ? source[rowStart + x - sourceBytesPerPixel]! : 0;
      const above = y > 0 ? source[previousRowStart + x]! : 0;
      const upperLeft = y > 0 && x >= sourceBytesPerPixel ? source[previousRowStart + x - sourceBytesPerPixel]! : 0;
      if (filter === 0) source[rowStart + x] = raw;
      else if (filter === 1) source[rowStart + x] = (raw + left) & 0xff;
      else if (filter === 2) source[rowStart + x] = (raw + above) & 0xff;
      else if (filter === 3) source[rowStart + x] = (raw + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) source[rowStart + x] = (raw + paeth(left, above, upperLeft)) & 0xff;
      else throw new Error(`Unsupported screenshot PNG filter ${filter}`);
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = y * sourceRowLength + x * sourceBytesPerPixel;
      const targetOffset = (y * width + x) * 4;
      if (colorType === 6) {
        data[targetOffset] = source[sourceOffset]!;
        data[targetOffset + 1] = source[sourceOffset + 1]!;
        data[targetOffset + 2] = source[sourceOffset + 2]!;
        data[targetOffset + 3] = source[sourceOffset + 3]!;
      } else if (colorType === 2) {
        data[targetOffset] = source[sourceOffset]!;
        data[targetOffset + 1] = source[sourceOffset + 1]!;
        data[targetOffset + 2] = source[sourceOffset + 2]!;
        data[targetOffset + 3] = 255;
      } else if (colorType === 4) {
        data[targetOffset] = source[sourceOffset]!;
        data[targetOffset + 1] = source[sourceOffset]!;
        data[targetOffset + 2] = source[sourceOffset]!;
        data[targetOffset + 3] = source[sourceOffset + 1]!;
      } else {
        data[targetOffset] = source[sourceOffset]!;
        data[targetOffset + 1] = source[sourceOffset]!;
        data[targetOffset + 2] = source[sourceOffset]!;
        data[targetOffset + 3] = 255;
      }
    }
  }
  return { buffer, width, height, data, clip };
}

export async function screenshotRegion(
  page: Page,
  target: Locator,
): Promise<TerminalPixelImage> {
  const box = await target.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error("Terminal viewport has no measurable compositor region");
  const clip = {
    x: Math.max(0, Math.floor(box.x)),
    y: Math.max(0, Math.floor(box.y)),
    width: Math.max(1, Math.ceil(box.width)),
    height: Math.max(1, Math.ceil(box.height)),
  } satisfies PixelClip;
  const buffer = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
  return decodePng(buffer, clip);
}

export async function attachPixelCrop(
  testInfo: TestInfo,
  name: string,
  image: TerminalPixelImage,
): Promise<void> {
  await testInfo.attach(name, { body: image.buffer, contentType: "image/png" });
}

export function analyzePixels(image: TerminalPixelImage, backgroundDistance = 12): PixelAnalysis {
  const colors = new Map<string, { color: [number, number, number, number]; count: number }>();
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const color: [number, number, number, number] = [
      image.data[offset]!, image.data[offset + 1]!, image.data[offset + 2]!, image.data[offset + 3]!,
    ];
    const key = color.join(",");
    const previous = colors.get(key);
    if (previous) previous.count += 1;
    else colors.set(key, { color, count: 1 });
  }
  let dominant = { color: [0, 0, 0, 0] as [number, number, number, number], count: 0 };
  for (const entry of colors.values()) if (entry.count > dominant.count) dominant = entry;
  let nonBackgroundPixels = 0;
  const dominantData = new Uint8Array(dominant.color);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const dominantDistance = pixelDistance(image.data, offset, dominantData, 0);
    if (dominantDistance > backgroundDistance) nonBackgroundPixels += 1;
  }
  const pixelCount = image.width * image.height;
  return {
    width: image.width,
    height: image.height,
    nonBackgroundPixels,
    nonBackgroundRatio: pixelCount ? nonBackgroundPixels / pixelCount : 0,
    uniqueColorCount: colors.size,
    dominantColorPixels: dominant.count,
    dominantColor: dominant.color,
  };
}
export async function expectTerminalNonBlank(
  page: Page,
  target: Locator,
  options: NonBlankOptions = {},
): Promise<PixelAnalysis> {
  const image = await screenshotRegion(page, target);
  const analysis = analyzePixels(image, options.colorDistance ?? 12);
  const minimumRatio = options.minimumNonBackgroundRatio ?? 0.002;
  const pixelCount = image.width * image.height;
  const maxSingleColorPixels = options.maxSingleColorPixels
    ?? Math.floor(pixelCount * (1 - minimumRatio));
  try {
    expect(analysis.nonBackgroundRatio, "terminal compositor region is blank").toBeGreaterThanOrEqual(minimumRatio);
    expect(analysis.dominantColorPixels, "terminal compositor region is a single color")
      .toBeLessThanOrEqual(maxSingleColorPixels);
  } catch (error) {
    if (options.testInfo) await attachPixelCrop(options.testInfo, options.artifactName ?? "terminal-crop", image);
    throw error;
  }
  return analysis;
}

export function changedPixelCount(
  before: TerminalPixelImage,
  after: TerminalPixelImage,
  threshold = 12,
): number {
  if (before.width !== after.width || before.height !== after.height) throw new Error("Cannot compare screenshots with different dimensions");
  let changed = 0;
  for (let offset = 0; offset < before.data.length; offset += 4) {
    if (pixelDistance(before.data, offset, after.data, offset) > threshold) changed += 1;
  }
  return changed;
}

export function changedPixelRatio(
  before: TerminalPixelImage,
  after: TerminalPixelImage,
  threshold = 12,
): number {
  return changedPixelCount(before, after, threshold) / (before.width * before.height);
}

export async function expectTerminalPixelsChanged(
  before: TerminalPixelImage,
  after: TerminalPixelImage,
  options: ChangedPixelOptions = {},
): Promise<number> {
  const ratio = changedPixelRatio(before, after, options.colorDistance ?? 12);
  try {
    expect(ratio, "terminal compositor pixels did not change").toBeGreaterThanOrEqual(options.minimumChangedRatio ?? 0.002);
  } catch (error) {
    if (options.testInfo) await attachPixelCrop(options.testInfo, options.artifactName ?? "terminal-after-crop", after);
    throw error;
  }
  return ratio;
}

export async function expectKnownMarkerChanged(
  page: Page,
  target: Locator,
  before: TerminalPixelImage,
  options: ChangedPixelOptions = {},
): Promise<{ readonly after: TerminalPixelImage; readonly changedRatio: number }> {
  const after = await screenshotRegion(page, target);
  const changedRatio = await expectTerminalPixelsChanged(before, after, options);
  return { after, changedRatio };
}

export const cropTerminalViewport = screenshotRegion;
export const assertNonBlankCompositor = expectTerminalNonBlank;
