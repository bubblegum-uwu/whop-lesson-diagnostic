import { describe, it, expect } from "vitest";
import {
  parseBearerToken,
  requireBearerToken,
  MissingAuthorizationError,
} from "../src/lib/authHeader.js";

describe("parseBearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(parseBearerToken("Bearer abc123XYZ")).toBe("abc123XYZ");
  });

  it("is case-insensitive on the Bearer scheme", () => {
    expect(parseBearerToken("bearer abc123XYZ")).toBe("abc123XYZ");
    expect(parseBearerToken("BEARER abc123XYZ")).toBe("abc123XYZ");
  });

  it("returns null when the header is missing", () => {
    expect(parseBearerToken(undefined)).toBeNull();
  });

  it("returns null when the header is empty", () => {
    expect(parseBearerToken("")).toBeNull();
  });

  it("returns null when the scheme is not Bearer", () => {
    expect(parseBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
  });

  it("returns null when there is no token after Bearer", () => {
    expect(parseBearerToken("Bearer")).toBeNull();
    expect(parseBearerToken("Bearer ")).toBeNull();
  });

  it("returns null for multiple Authorization header values (array)", () => {
    expect(parseBearerToken(["Bearer abc", "Bearer def"])).toBeNull();
  });

  it("returns null when the token contains internal whitespace", () => {
    expect(parseBearerToken("Bearer abc 123")).toBeNull();
  });

  it("trims surrounding whitespace on the header value", () => {
    expect(parseBearerToken("   Bearer abc123XYZ  ")).toBe("abc123XYZ");
  });
});

describe("requireBearerToken", () => {
  it("returns the token when present", () => {
    expect(requireBearerToken("Bearer good-token")).toBe("good-token");
  });

  it("throws MissingAuthorizationError when absent", () => {
    expect(() => requireBearerToken(undefined)).toThrow(MissingAuthorizationError);
  });

  it("throws MissingAuthorizationError when malformed", () => {
    expect(() => requireBearerToken("Token abc")).toThrow(MissingAuthorizationError);
  });
});
