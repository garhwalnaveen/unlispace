import { describe, expect, it } from "vitest";
import {
  desktopCallback,
  desktopParameters,
  driveLink,
  finderLink,
  safeReturn,
} from "../src/links";
describe("desktop handoff URLs", () => {
  it("encodes code and state exclusively in the callback fragment", () => {
    const url = new URL(desktopCallback("code&with=characters", "state/+?#"));
    expect(url.protocol).toBe("uls:");
    expect(url.host).toBe("auth");
    expect(url.pathname).toBe("/callback");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("code")).toBe(
      "code&with=characters",
    );
    expect(new URLSearchParams(url.hash.slice(1)).get("state")).toBe(
      "state/+?#",
    );
  });
  it("validates PKCE input without changing the original state", () => {
    expect(
      desktopParameters(
        `?state=opaque%2Bstate&code_challenge=${"a".repeat(43)}`,
      ),
    ).toEqual({ state: "opaque+state", codeChallenge: "a".repeat(43) });
    expect(() => desktopParameters("?state=s")).toThrow("invalid");
    expect(() => desktopParameters("?state=s&code_challenge=bad")).toThrow(
      "invalid",
    );
  });
  it("keeps folder and special-character paths intact in Finder and browser links", () => {
    const url = new URL(finderLink("d-test", "folder/a #?.txt"));
    expect(url.searchParams.get("path")).toBe("folder/a #?.txt");
    expect(driveLink("d-test", "folder/a #?.txt")).toBe(
      "/drives/d-test/folder/a%20%23%3F.txt",
    );
  });
  it("only accepts local return paths", () => {
    expect(safeReturn("/desktop?state=a")).toBe("/desktop?state=a");
    for (const bad of [
      "//evil.test",
      "/\\evil.test",
      "https://evil.test",
      null,
    ])
      expect(safeReturn(bad)).toBe("/");
  });
});
