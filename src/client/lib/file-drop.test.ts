import { describe, expect, it } from "vitest";
import {
  TEMP_UPLOAD_DIRECTORY,
  fileDropDestination,
  fileDropPastes,
  fileZoneAt,
  shellQuote,
} from "./file-drop";

describe("fileZoneAt", () => {
  const width = 1000;
  const height = 800;

  it("splits the surface into four quadrants with no dead zone", () => {
    expect(fileZoneAt(width, height, 10, 10)).toBe("top-left");
    expect(fileZoneAt(width, height, 990, 10)).toBe("top-right");
    expect(fileZoneAt(width, height, 10, 790)).toBe("bottom-left");
    expect(fileZoneAt(width, height, 990, 790)).toBe("bottom-right");
  });

  it("assigns points on the midlines to a quadrant", () => {
    expect(fileZoneAt(width, height, width / 2, 10)).toBe("top-right");
    expect(fileZoneAt(width, height, 10, height / 2)).toBe("bottom-left");
    expect(fileZoneAt(width, height, width / 2, height / 2)).toBe("bottom-right");
  });
});

describe("fileDropDestination", () => {
  it("routes the bottom row to the temp folder and the top row to the terminal", () => {
    expect(fileDropDestination("top-left", "/home/user")).toBe("/home/user");
    expect(fileDropDestination("top-right", "/home/user")).toBe("/home/user");
    expect(fileDropDestination("bottom-left", "/home/user")).toBe(TEMP_UPLOAD_DIRECTORY);
    expect(fileDropDestination("bottom-right", "/home/user")).toBe(TEMP_UPLOAD_DIRECTORY);
  });
});

describe("fileDropPastes", () => {
  it("pastes only in the left column", () => {
    expect(fileDropPastes("top-left")).toBe(true);
    expect(fileDropPastes("bottom-left")).toBe(true);
    expect(fileDropPastes("top-right")).toBe(false);
    expect(fileDropPastes("bottom-right")).toBe(false);
  });
});

describe("shellQuote", () => {
  it("leaves plain paths untouched", () => {
    expect(shellQuote("/home/user/report.txt")).toBe("/home/user/report.txt");
    expect(shellQuote("/tmp/a-b_c.1")).toBe("/tmp/a-b_c.1");
  });

  it("single-quotes paths containing shell metacharacters", () => {
    expect(shellQuote("/tmp/my report.txt")).toBe("'/tmp/my report.txt'");
    expect(shellQuote("/tmp/it's.txt")).toBe("'/tmp/it'\\''s.txt'");
    expect(shellQuote("/tmp/a$b*c")).toBe("'/tmp/a$b*c'");
  });
});
