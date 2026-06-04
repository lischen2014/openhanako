import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadSubagentDef() {
  const filePath = resolve(ROOT, "desktop", "src", "locales", "en.json");
  return JSON.parse(readFileSync(filePath, "utf8")).toolDef.subagent;
}

describe("subagent tool schema copy", () => {
  it("keeps description concise", () => {
    const def = loadSubagentDef();
    expect(def.description.length).toBeLessThan(280);
  });

  it("does not duplicate generic background task polling rules", () => {
    const def = loadSubagentDef();
    expect(def.description).not.toContain("check_pending_tasks");
    expect(def.description).not.toContain("Check at most");
    expect(def.description).not.toContain("<hana-background-result>");
  });

  it("uses current thread/id semantics", () => {
    const def = loadSubagentDef();
    expect(def.agentDesc).toMatch(/backticks/);
    expect(def.agentDesc).toMatch(/persona/);
    expect(def.agentDesc).toMatch(/model/);
    expect(def.agentDesc).not.toMatch(/parentheses/);
    expect(def.labelDesc).toMatch(/display/i);
    expect(def.labelDesc).toMatch(/threadId|subagent_reply/);
    expect(def.instanceDesc).toMatch(/[Ll]egacy/);
    expect(def.instanceDesc).not.toMatch(/ephemeral thread|no memory/);
    expect(def.modelDesc).toMatch(/chat model/);
    expect(def.modelDesc).not.toMatch(/utility/);
  });
});
