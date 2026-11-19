import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reports every missing setting at once", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (e) {
      expect((e as Error).message).toMatch(/UAT_BASE_URL/);
      expect((e as Error).message).toMatch(/UAT_PASSPHRASE/);
    }
  });

  it("rejects plain http except for localhost", () => {
    expect(() => loadConfig({ UAT_BASE_URL: "http://uat.example.com", UAT_PASSPHRASE: "x" })).toThrow(/https/);
    expect(loadConfig({ UAT_BASE_URL: "http://localhost:3000", UAT_PASSPHRASE: "x" }).baseUrl).toBe("http://localhost:3000");
  });

  it("strips trailing slashes and applies defaults", () => {
    const c = loadConfig({ UAT_BASE_URL: "https://uat.example.com/", UAT_PASSPHRASE: "x" });
    expect(c).toEqual({ baseUrl: "https://uat.example.com", passphrase: "x", timeoutMs: 15000, maxImageBytes: 1500000 });
  });

  it("validates numeric settings", () => {
    expect(() => loadConfig({ UAT_BASE_URL: "https://a.b", UAT_PASSPHRASE: "x", UAT_TIMEOUT_MS: "fast" })).toThrow(/UAT_TIMEOUT_MS/);
  });
});

import { parseEnvFile } from "../src/config.js";

describe("parseEnvFile", () => {
  it("reads only UAT_* keys and reports the rest as ignored", () => {
    const { vars, ignored } = parseEnvFile(
      [
        "# comment",
        "UAT_BASE_URL=https://uat.example.com",
        'export UAT_PASSPHRASE="p@ss word#1"',
        "UAT_TIMEOUT_MS=20000   # inline comment",
        "MONGODB_URI=mongodb+srv://secret",
        "ADMIN_PASSWORD=nope",
        "",
        "not a valid line",
      ].join("\n"),
    );
    expect(vars).toEqual({ UAT_BASE_URL: "https://uat.example.com", UAT_PASSPHRASE: "p@ss word#1", UAT_TIMEOUT_MS: "20000" });
    expect(ignored).toEqual(["MONGODB_URI", "ADMIN_PASSWORD"]);
  });
});
