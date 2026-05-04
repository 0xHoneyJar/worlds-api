/**
 * world-manifest schema tests (v1.0 + v1.1 additive).
 *
 * v1.1 (cycle-Q · 2026-05-04 · sprint-3 Q3.1) adds:
 *   - quest_namespace (optional)
 *   - quest_engine_config (optional)
 *   - guild_ids (optional)
 *
 * Architect lock A7: ADDITIVE minor bump · v1.0 documents validate unchanged.
 *
 * Run with `bun test packages/protocol/__tests__/world-manifest.test.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "bun:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(
  __dirname,
  "../../protocol/world-manifest.schema.json",
);
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

function makeValidator(): (data: unknown) => boolean {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe("world-manifest schema · v1.0 backcompat (A7 architect lock)", () => {
  it("accepts v1.0 minimal manifest", () => {
    const v10Minimal = {
      schema_version: "1.0",
      slug: "test-world",
      name: "Test World",
      repo: "0xHoneyJar/test-world",
    };
    const validate = makeValidator();
    const ok = validate(v10Minimal);
    expect(ok).toBe(true);
  });

  it("accepts v1.0 with hosting + identity (production shape)", () => {
    const v10Full = {
      schema_version: "1.0",
      slug: "mibera",
      name: "Mibera",
      repo: "0xHoneyJar/mibera-honeyroad",
      hosting: { type: "ECSHosting", cpu: 512, memory: 1024 },
      identity: [{ type: "DynamicAuth", cookie_domain: "auth.0xhoneyjar.xyz" }],
    };
    const validate = makeValidator();
    const ok = validate(v10Full);
    expect(ok).toBe(true);
  });
});

describe("world-manifest schema · v1.1 additive fields (cycle-Q · sprint-3 Q3.1)", () => {
  it("accepts v1.1 schema_version literal", () => {
    const v11Minimal = {
      schema_version: "1.1",
      slug: "test-world",
      name: "Test World",
      repo: "0xHoneyJar/test-world",
    };
    const validate = makeValidator();
    const ok = validate(v11Minimal);
    expect(ok).toBe(true);
  });

  it("accepts quest_namespace as kebab-case slug", () => {
    const withQuestNs = {
      schema_version: "1.1",
      slug: "mibera",
      name: "Mibera",
      repo: "0xHoneyJar/mibera-honeyroad",
      quest_namespace: "mibera-grails",
    };
    const validate = makeValidator();
    expect(validate(withQuestNs)).toBe(true);
  });

  it("rejects quest_namespace with invalid pattern (uppercase)", () => {
    const bad = {
      schema_version: "1.1",
      slug: "mibera",
      name: "Mibera",
      repo: "0xHoneyJar/mibera-honeyroad",
      quest_namespace: "Mibera-Grails",
    };
    const validate = makeValidator();
    expect(validate(bad)).toBe(false);
  });

  it("accepts full quest_engine_config shape", () => {
    const withConfig = {
      schema_version: "1.1",
      slug: "mibera",
      name: "Mibera",
      repo: "0xHoneyJar/mibera-honeyroad",
      quest_namespace: "mibera-grails",
      quest_engine_config: {
        questAcceptanceMode: "open-badge-gated",
        submissionStyle: "inline_thread",
        positiveFrictionDelayMs: 12000,
      },
    };
    const validate = makeValidator();
    expect(validate(withConfig)).toBe(true);
  });

  it("rejects quest_engine_config with unknown questAcceptanceMode", () => {
    const bad = {
      schema_version: "1.1",
      slug: "mibera",
      name: "Mibera",
      repo: "0xHoneyJar/mibera-honeyroad",
      quest_engine_config: {
        questAcceptanceMode: "wide-open",
        submissionStyle: "inline_thread",
        positiveFrictionDelayMs: 12000,
      },
    };
    const validate = makeValidator();
    expect(validate(bad)).toBe(false);
  });

  it("rejects quest_engine_config with positiveFrictionDelayMs > 30000", () => {
    const bad = {
      schema_version: "1.1",
      slug: "mibera",
      name: "Mibera",
      repo: "0xHoneyJar/mibera-honeyroad",
      quest_engine_config: {
        questAcceptanceMode: "open",
        submissionStyle: "modal_form",
        positiveFrictionDelayMs: 31000,
      },
    };
    const validate = makeValidator();
    expect(validate(bad)).toBe(false);
  });

  it("accepts guild_ids as snowflake strings", () => {
    const withGuilds = {
      schema_version: "1.1",
      slug: "mibera",
      name: "Mibera",
      repo: "0xHoneyJar/mibera-honeyroad",
      guild_ids: ["123456789012345678", "234567890123456789"],
    };
    const validate = makeValidator();
    expect(validate(withGuilds)).toBe(true);
  });

  it("rejects guild_ids with non-snowflake strings", () => {
    const bad = {
      schema_version: "1.1",
      slug: "mibera",
      name: "Mibera",
      repo: "0xHoneyJar/mibera-honeyroad",
      guild_ids: ["not-a-snowflake"],
    };
    const validate = makeValidator();
    expect(validate(bad)).toBe(false);
  });

  it("accepts manifest with all v1.1 quest fields combined (full SDD §7.1 shape)", () => {
    const full = {
      schema_version: "1.1",
      slug: "mibera",
      name: "Mibera Dimensions",
      repo: "0xHoneyJar/mibera-honeyroad",
      compose_with: [
        {
          slug: "freeside-quests",
          relationship:
            "consumes the quest substrate engine + discord-renderer for Mongolian NPC",
        },
      ],
      quest_namespace: "mibera-grails",
      quest_engine_config: {
        questAcceptanceMode: "open-badge-gated",
        submissionStyle: "inline_thread",
        positiveFrictionDelayMs: 12000,
      },
      guild_ids: ["123456789012345678", "234567890123456789"],
    };
    const validate = makeValidator();
    expect(validate(full)).toBe(true);
  });
});
