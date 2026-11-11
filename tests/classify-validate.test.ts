import { describe, expect, it } from "vitest";
import { classifyTool } from "../lib/mcp/classify";
import { makeValidator } from "../lib/mcp/validate";

const schema = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });

describe("classifyTool", () => {
  it("trusts server annotations first", () => {
    expect(classifyTool({ name: "delete_everything", annotations: { readOnlyHint: true } }).kind).toBe("read");
    expect(classifyTool({ name: "get_lab", annotations: { destructiveHint: true } }).kind).toBe("destructive");
  });
  it("falls back to names, conservatively", () => {
    expect(classifyTool({ name: "get_nodes", inputSchema: schema({ lid: {} }) }).kind).toBe("read");
    expect(classifyTool({ name: "wipe_lab" }).kind).toBe("destructive");
    expect(classifyTool({ name: "stop_node" }).kind).toBe("destructive");
    expect(classifyTool({ name: "start_node" }).kind).toBe("write");
    expect(classifyTool({ name: "frobnicate" }).kind).toBe("write");
  });
  it("marks command runners with a mode argument as mixed, whatever the name says", () => {
    const t = { name: "send_cli_command", inputSchema: schema({ label: {}, commands: {}, config_command: { type: "boolean" } }) };
    expect(classifyTool(t).kind).toBe("mixed");
    expect(classifyTool({ name: "show_thing", inputSchema: schema({ command: {}, apply: {} }) }).kind).toBe("mixed");
    // The live CML server marks send_cli_command destructive; it must still surface as mixed.
    expect(classifyTool({ ...t, annotations: { destructiveHint: true } }).kind).toBe("mixed");
    expect(classifyTool({ name: "run_commands" }).kind).toBe("mixed");
  });
  it("always explains itself", () => {
    expect(classifyTool({ name: "x" }).reason.length).toBeGreaterThan(5);
  });
});

describe("makeValidator", () => {
  const v = makeValidator(schema({ lid: { type: "string" }, count: { type: "integer" } }, ["lid"]));
  it("accepts valid arguments", () => {
    expect(v({ lid: "abc", count: 2 })).toEqual({ ok: true });
  });
  it("reports missing and mistyped arguments", () => {
    const missing = v({});
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.errors.join()).toMatch(/lid/);
    const wrong = v({ lid: 5 });
    expect(wrong.ok === false && wrong.errors.join()).toMatch(/lid.*string/);
  });
  it("tolerates unknown keywords and formats in server schemas", () => {
    const loose = makeValidator({ type: "object", properties: { id: { type: "string", format: "uuid4", "x-vendor": 1 } } });
    expect(loose({ id: "not-checked" })).toEqual({ ok: true });
  });
  it("handles schemas that declare different JSON Schema drafts", () => {
    for (const $schema of ["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2020-12/schema"]) {
      const s = makeValidator({ $schema, $id: "same-id", type: "object", properties: { a: { type: "string" } }, required: ["a"] });
      expect(s({ a: "x" })).toEqual({ ok: true });
      expect(s({}).ok).toBe(false);
    }
  });
  it("refuses to wave arguments through when the schema is unusable", () => {
    const bad = makeValidator({ type: "nonsense" });
    expect(bad({}).ok).toBe(false);
  });
});
