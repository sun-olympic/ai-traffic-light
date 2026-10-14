import { describe, expect, test } from "vitest";
import { COLLAPSED_WINDOW_SIZE, COLLAPSED_WINDOW_WIDTH, fitWindowHeight } from "./widget-layout";

describe("fitWindowHeight", () => {
  test("lets a collapsed traffic light shrink to its actual content height", () => {
    expect(fitWindowHeight(184, 1)).toBe(194);
  });

  test("keeps the expanded panel minimum and maximum bounds", () => {
    expect(fitWindowHeight(100, 250)).toBe(250);
    expect(fitWindowHeight(900, 250)).toBe(700);
  });
});

describe("collapsed window width", () => {
  test("uses the same compact size for the native window's initial bounds", () => {
    expect(COLLAPSED_WINDOW_SIZE).toEqual({ width: 70, height: 196 });
  });

  test("matches the lamp housing plus the widget's horizontal padding", () => {
    expect(COLLAPSED_WINDOW_WIDTH).toBe(70);
  });
});
