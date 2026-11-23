import { describe, expect, it } from "vitest";
import { ConfigError, describeMcp, loadAnthropicConfig, loadMcpConfig, redactArgs, splitArgs, withEnvReferences } from "../lib/config";

describe("splitArgs", () => {
  it("handles empty, plain, quoted and JSON forms", () => {
    expect(splitArgs(undefined)).toEqual([]);
    expect(splitArgs("-m cml_mcp --verbose")).toEqual(["-m", "cml_mcp", "--verbose"]);
    expect(splitArgs(`--name "My Lab" 'a b'`)).toEqual(["--name", "My Lab", "a b"]);
    expect(splitArgs('["-m","cml mcp"]')).toEqual(["-m", "cml mcp"]);
  });
  it("rejects broken JSON", () => {
    expect(() => splitArgs("[oops")).toThrow(ConfigError);
    expect(() => splitArgs("[1,2]")).toThrow(/array of strings/);
  });
});

describe("loadMcpConfig", () => {
  it("builds stdio config with args and env", () => {
    const c = loadMcpConfig({ CML_MCP_TRANSPORT: "stdio", CML_MCP_COMMAND: "uvx", CML_MCP_ARGS: "cml-mcp", CML_MCP_ENV: '{"CML_URL":"https://x"}' });
    expect(c).toEqual({ transport: "stdio", command: "uvx", args: ["cml-mcp"], env: { CML_URL: "https://x" } });
  });
  it("turns {{VAR}} into ${VAR} for launchers that expand it themselves, leaving other args alone", () => {
    const c = loadMcpConfig({
      CML_MCP_TRANSPORT: "stdio",
      CML_MCP_COMMAND: "npx",
      CML_MCP_ARGS: '["-y","mcp-remote","https://h/mcp","--header","X-Authorization:{{CML_AUTH_HEADER}}"]',
    });
    expect(c.transport === "stdio" && c.args.at(-1)).toBe("X-Authorization:${CML_AUTH_HEADER}");
    expect(c.transport === "stdio" && c.args[0]).toBe("-y");
    expect(withEnvReferences("{{A}}-{{B_2}}")).toBe("${A}-${B_2}");
    expect(withEnvReferences("{{not valid}} {single}")).toBe("{{not valid}} {single}");
  });
  it("builds http config and accepts the streamable-http alias", () => {
    const c = loadMcpConfig({ CML_MCP_TRANSPORT: "streamable-http", CML_MCP_URL: "http://localhost:9000/mcp", CML_MCP_HEADERS: '{"Authorization":"Bearer t"}' });
    expect(c).toEqual({ transport: "http", url: "http://localhost:9000/mcp", headers: { Authorization: "Bearer t" } });
  });
  it("infers transport only when unambiguous", () => {
    expect(loadMcpConfig({ CML_MCP_COMMAND: "x" }).transport).toBe("stdio");
    expect(loadMcpConfig({ CML_MCP_URL: "http://h/mcp" }).transport).toBe("http");
    expect(() => loadMcpConfig({})).toThrow(/CML_MCP_TRANSPORT/);
    expect(() => loadMcpConfig({ CML_MCP_COMMAND: "x", CML_MCP_URL: "http://h" })).toThrow(/CML_MCP_TRANSPORT/);
  });
  it("names exactly what is missing", () => {
    try {
      loadMcpConfig({ CML_MCP_TRANSPORT: "stdio" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ConfigError).missing).toEqual(["CML_MCP_COMMAND"]);
    }
    expect(() => loadMcpConfig({ CML_MCP_TRANSPORT: "http" })).toThrow(/CML_MCP_URL/);
    expect(() => loadMcpConfig({ CML_MCP_TRANSPORT: "http", CML_MCP_URL: "nope" })).toThrow(/valid URL/);
    expect(() => loadMcpConfig({ CML_MCP_TRANSPORT: "carrier-pigeon" })).toThrow(/not supported/);
  });
  it("rejects malformed env and header JSON", () => {
    expect(() => loadMcpConfig({ CML_MCP_COMMAND: "x", CML_MCP_ENV: "{bad" })).toThrow(/JSON object/);
    expect(() => loadMcpConfig({ CML_MCP_COMMAND: "x", CML_MCP_ENV: '{"A":1}' })).toThrow(/must be a string/);
    expect(() => loadMcpConfig({ CML_MCP_URL: "http://h", CML_MCP_HEADERS: "[1]" })).toThrow(/JSON object/);
  });
});

describe("loadAnthropicConfig", () => {
  it("needs a key and a model", () => {
    expect(loadAnthropicConfig({ ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "m" })).toEqual({ apiKey: "k", model: "m" });
    expect(() => loadAnthropicConfig({ ANTHROPIC_MODEL: "m" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadAnthropicConfig({})).toThrow(/ANTHROPIC_API_KEY and ANTHROPIC_MODEL/);
  });
});

describe("secrets never show in descriptions", () => {
  it("masks secret-looking flags", () => {
    expect(redactArgs(["--api-key", "abc", "--token=xyz", "--lab", "demo"])).toEqual(["--api-key", "***", "--token=***", "--lab", "demo"]);
  });
  it("omits env and header values", () => {
    const stdio = describeMcp({ transport: "stdio", command: "srv", args: ["--password=p"], env: { CML_PASSWORD: "hunter2" } });
    expect(stdio).not.toContain("hunter2");
    expect(stdio).not.toContain("p ");
    expect(stdio).toContain("CML_PASSWORD");
    const http = describeMcp({ transport: "http", url: "http://h/mcp?key=secret", headers: { Authorization: "Bearer top" } });
    expect(http).not.toContain("top");
    expect(http).not.toContain("secret");
  });
});
