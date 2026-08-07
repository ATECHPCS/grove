import { describe, expect, it } from "vitest";
import { extractThoughtStatus } from "./thoughtStatus";

describe("extractThoughtStatus", () => {
  it("extracts a standalone bold heading", () => {
    expect(
      extractThoughtStatus(
        "**Checking status and committing changes**\n\nPrivate reasoning body",
      ),
    ).toBe("Checking status and committing changes");
  });

  it("uses the latest heading while thought content streams", () => {
    expect(
      extractThoughtStatus(
        [
          "**Checking Go module and package versions**",
          "",
          "**Evaluating ToolConfig abstraction necessity**",
          "",
          "**Refining Invoke API design and naming**",
        ].join("\n"),
      ),
    ).toBe("Refining Invoke API design and naming");
  });

  it("accepts a markdown heading wrapped in bold", () => {
    expect(extractThoughtStatus("### **Searching for InvocationRequest definition**"))
      .toBe("Searching for InvocationRequest definition");
  });

  it("does not expose ordinary reasoning or inline emphasis", () => {
    expect(extractThoughtStatus("I should **check the status** before editing."))
      .toBe("Thinking");
    expect(extractThoughtStatus("No heading yet"))
      .toBe("Thinking");
  });
});
