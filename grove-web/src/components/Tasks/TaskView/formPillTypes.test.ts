import { describe, expect, it } from "vitest";
import { elicitationToSurvey, type AcpElicitationSnapshot } from "./formPillTypes";

function snapshot(properties: Record<string, Record<string, unknown>>): AcpElicitationSnapshot {
  return {
    request_id: "request-1",
    agent_name: "Test Agent",
    request: {
      mode: "form",
      message: "Tell me about the deployment",
      requestedSchema: {
        title: "Deployment",
        properties,
        required: ["environment"],
      },
    },
  };
}

describe("elicitationToSurvey", () => {
  it("maps ACP form constraints into the shared survey model", () => {
    const result = elicitationToSurvey(snapshot({
      environment: {
        type: "string",
        title: "Environment",
        oneOf: [
          { const: "staging", title: "Staging" },
          { const: "production", title: "Production" },
        ],
      },
      replicas: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        default: 2,
      },
      regions: {
        type: "array",
        items: { type: "string", enum: ["us", "eu"] },
        minItems: 1,
      },
    }));

    expect(result?.title).toBe("Deployment");
    expect(result?.questions).toEqual([
      expect.objectContaining({
        id: "environment",
        type: "single_choice",
        required: true,
        allowCustom: false,
        options: [
          { id: "staging", label: "Staging", description: undefined },
          { id: "production", label: "Production", description: undefined },
        ],
      }),
      expect.objectContaining({
        id: "replicas",
        type: "number",
        integer: true,
        minimum: 1,
        maximum: 10,
        default: 2,
      }),
      expect.objectContaining({
        id: "regions",
        type: "multi_choice",
        minItems: 1,
        allowCustom: false,
      }),
    ]);
  });

  it("rejects unknown property types instead of rendering raw input", () => {
    expect(elicitationToSurvey(snapshot({ secret: { type: "object" } }))).toBeNull();
  });
});
