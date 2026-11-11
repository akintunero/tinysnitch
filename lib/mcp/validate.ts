import Ajv2020 from "ajv/dist/2020.js";

// MCP input schemas are JSON Schema; unknown keywords and formats must not break discovery.
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });

export type Validation = { ok: true } | { ok: false; errors: string[] };
export type ArgValidator = (args: unknown) => Validation;

export function makeValidator(schema: unknown): ArgValidator {
  let check: ReturnType<typeof ajv.compile>;
  try {
    // Servers declare different drafts ($schema) and may reuse $id values; neither matters for
    // checking one call's arguments, and a draft we haven't loaded would make compile() throw.
    const { $schema: _s, $id: _i, ...body } = (schema && typeof schema === "object" ? schema : { type: "object" }) as Record<string, unknown>;
    check = ajv.compile(body);
  } catch {
    // A schema we can't compile is reported as such rather than silently accepting anything.
    return () => ({ ok: false, errors: ["the tool's input schema could not be compiled, so its arguments can't be validated"] });
  }
  return (args) => {
    if (check(args ?? {})) return { ok: true };
    return {
      ok: false,
      errors: (check.errors ?? []).map((e) => `${e.instancePath || "(arguments)"} ${e.message ?? "is invalid"}`.trim()),
    };
  };
}
