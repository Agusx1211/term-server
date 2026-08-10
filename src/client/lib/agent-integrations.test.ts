import { describe, expect, it } from "vitest";
import type { AgentIntegrationProfileStatus } from "../../shared/types";
import {
  agentIntegrationActionFor,
  agentIntegrationProfileSummary,
} from "./agent-integrations";

const profile = (state: AgentIntegrationProfileStatus["state"], id: string): AgentIntegrationProfileStatus => ({
  id,
  label: id === "default" ? "Default" : id,
  state,
  message: "safe",
});

describe("OMP integration aggregate actions", () => {
  it("installs only when the aggregate is missing and profiles exist", () => {
    expect(agentIntegrationActionFor({
      provider: "omp",
      state: "notInstalled",
      profiles: [profile("notInstalled", "default")],
    })).toBe("install");
    expect(agentIntegrationActionFor({
      provider: "omp",
      state: "needsRepair",
      profiles: [profile("installed", "default"), profile("needsRepair", "work")],
    })).toBe("repair");
  });

  it("does not offer a misleading install action with no profiles", () => {
    expect(agentIntegrationActionFor({ provider: "omp", state: "notInstalled", profiles: [] })).toBeNull();
    expect(agentIntegrationActionFor({ provider: "omp", state: "unavailable", profiles: [] })).toBeNull();
  });

  it("summarizes mixed profile states compactly", () => {
    expect(agentIntegrationProfileSummary([
      profile("installed", "default"),
      profile("notInstalled", "work"),
      profile("needsRepair", "review"),
    ])).toBe("1 installed · 1 missing · 1 needs repair");
    expect(agentIntegrationProfileSummary([])).toBeNull();
  });
});
