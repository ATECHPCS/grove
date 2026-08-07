import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "../../../api/tasks";
import {
  configDropdownValues,
  flattenConfigValues,
  quickConfigOptions,
} from "./sessionConfigOptions";

describe("session config options", () => {
  it("matches the first model, mode, and thinking options without dropping others", () => {
    const options: SessionConfigOption[] = [
      { id: "custom", name: "Custom", type: "boolean", currentValue: true },
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [] },
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "build", options: [] },
      { id: "effort", name: "Effort", category: "effort", type: "select", currentValue: "high", options: [] },
    ];

    const quick = quickConfigOptions(options);

    expect(quick.model?.id).toBe("model");
    expect(quick.mode?.id).toBe("mode");
    expect(quick.thinking?.id).toBe("effort");
    expect(options[0].id).toBe("custom");
  });

  it("flattens grouped select values in Agent order", () => {
    const option: SessionConfigOption = {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "fast",
      options: [
        { group: "recommended", name: "Recommended", options: [{ value: "fast", name: "Fast" }] },
        { group: "advanced", name: "Advanced", options: [{ value: "deep", name: "Deep" }] },
      ],
    };

    expect(flattenConfigValues(option).map((value) => value.value)).toEqual([
      "fast",
      "deep",
    ]);
    expect(configDropdownValues(option).map((value) => value.group)).toEqual([
      "Recommended",
      "Advanced",
    ]);
  });
});
