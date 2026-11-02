import { test, expect } from "bun:test";
import { formatCost, formatElapsed, formatTokens, stateLabel } from "./format";

test("formatElapsed shows null, seconds, minutes and hours", () => {
  expect(formatElapsed(null)).toBe("-");
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(45)).toBe("45s");
  expect(formatElapsed(59)).toBe("59s");
  expect(formatElapsed(60)).toBe("1m 00s");
  expect(formatElapsed(185)).toBe("3m 05s");
  expect(formatElapsed(3599)).toBe("59m 59s");
  expect(formatElapsed(3600)).toBe("1h 00m");
  expect(formatElapsed(7325)).toBe("2h 02m");
});

test("formatCost shows null, free and four decimals", () => {
  expect(formatCost(null)).toBe("-");
  expect(formatCost(0)).toBe("free");
  expect(formatCost(0.0213)).toBe("$0.0213");
  expect(formatCost(1.5)).toBe("$1.5000");
  expect(formatCost(0.00004)).toBe("$0.0000");
});

test("formatTokens shows null, plain, thousands and millions", () => {
  expect(formatTokens(null)).toBe("-");
  expect(formatTokens(0)).toBe("0");
  expect(formatTokens(812)).toBe("812");
  expect(formatTokens(999)).toBe("999");
  expect(formatTokens(1000)).toBe("1k");
  expect(formatTokens(1049)).toBe("1k");
  expect(formatTokens(12_400)).toBe("12.4k");
  expect(formatTokens(999_999)).toBe("1000k");
  expect(formatTokens(1_000_000)).toBe("1M");
  expect(formatTokens(1_200_000)).toBe("1.2M");
});

test("stateLabel names every lane state", () => {
  expect(stateLabel("waiting")).toBe("waiting");
  expect(stateLabel("live")).toBe("live");
  expect(stateLabel("done")).toBe("done");
  expect(stateLabel("failed")).toBe("failed");
  expect(stateLabel("stalled")).toBe("stalled");
});
