import { describe, expect, it } from "vitest";
import {
  decodeEventTuple,
  toHex,
  toStr,
  toUint,
  unwrap,
} from "@/lib/chainhookDecode";

describe("unwrap", () => {
  it("strips one { value } layer", () => {
    expect(unwrap({ value: 7 })).toBe(7);
  });

  it("returns non-wrapped input unchanged", () => {
    expect(unwrap("plain")).toBe("plain");
  });
});

describe("toStr", () => {
  it("passes strings through and coerces numbers and bigints", () => {
    expect(toStr("abc")).toBe("abc");
    expect(toStr(42)).toBe("42");
    expect(toStr(42n)).toBe("42");
  });

  it("unwraps before coercing and returns null otherwise", () => {
    expect(toStr({ value: "wrapped" })).toBe("wrapped");
    expect(toStr({})).toBeNull();
    expect(toStr(null)).toBeNull();
  });
});

describe("toUint", () => {
  it("accepts a number", () => {
    expect(toUint(123)).toBe(123);
  });

  it("accepts a numeric string", () => {
    expect(toUint("123")).toBe(123);
  });

  it('accepts a Clarity "u123" string', () => {
    expect(toUint("u123")).toBe(123);
  });

  it("accepts a bigint and unwraps { value }", () => {
    expect(toUint(123n)).toBe(123);
    expect(toUint({ value: "u456" })).toBe(456);
  });

  it("truncates floats and rejects non-numeric input", () => {
    expect(toUint(12.9)).toBe(12);
    expect(toUint("not-a-number")).toBeNull();
    expect(toUint({})).toBeNull();
  });
});

describe("toHex", () => {
  it("0x-prefixes a bare buff hex string", () => {
    expect(toHex("AABBcc")).toBe("0xaabbcc");
  });

  it("lowercases an already 0x-prefixed string", () => {
    expect(toHex("0xDEADBEEF")).toBe("0xdeadbeef");
  });

  it("returns null for non-string input", () => {
    expect(toHex({})).toBeNull();
  });
});

describe("decodeEventTuple", () => {
  it("decodes a flat tuple", () => {
    const value = { event: "anchor-created", hash: "0xabc" };
    expect(decodeEventTuple(value)).toEqual({
      topic: "anchor-created",
      fields: value,
      raw: value,
    });
  });

  it("decodes a { value }-wrapped tuple", () => {
    const inner = { event: "anchor-created", label: "demo" };
    const value = { value: inner };
    expect(decodeEventTuple(value)).toEqual({
      topic: "anchor-created",
      fields: inner,
      raw: value,
    });
  });

  it("keeps a flat tuple that has a Clarity field named value", () => {
    const value = { event: "sale", value: "u100" };
    expect(decodeEventTuple(value)).toEqual({
      topic: "sale",
      fields: value,
      raw: value,
    });
  });

  it("returns topic null when the discriminator field is absent", () => {
    const value = { hash: "0xabc" };
    const decoded = decodeEventTuple(value);
    expect(decoded).not.toBeNull();
    expect(decoded?.topic).toBeNull();
    expect(decoded?.fields).toEqual(value);
  });

  it("returns null for an unrecognized envelope", () => {
    expect(decodeEventTuple("just-a-string")).toBeNull();
    expect(decodeEventTuple(42)).toBeNull();
    expect(decodeEventTuple(["a", "b"])).toBeNull();
    expect(decodeEventTuple(null)).toBeNull();
  });
});
