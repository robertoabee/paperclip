import { describe, expect, it } from "vitest";
import {
  isAiConnectionCompatible,
  isAiConnectionManagedAdapter,
  isAiConnectionSelfAuthenticatedAdapter,
} from "./ai-connections.js";

describe("self-authenticated adapters", () => {
  const selection = { provider: "openai", method: "api_key" } as const;

  it("recognizes Hermes Gateway and other gateways as self-authenticated", () => {
    expect(isAiConnectionSelfAuthenticatedAdapter("hermes_gateway")).toBe(true);
    expect(isAiConnectionSelfAuthenticatedAdapter("openclaw_gateway")).toBe(true);
    expect(isAiConnectionManagedAdapter("hermes_gateway")).toBe(false);
    expect(isAiConnectionManagedAdapter("codex_local")).toBe(true);
  });

  it("accepts self-authenticated gateways without a local provider binding", () => {
    expect(isAiConnectionCompatible(selection, "hermes_gateway")).toBe(true);
    expect(isAiConnectionCompatible(selection, "openclaw_gateway")).toBe(true);
  });

  it("does not silently accept unknown adapters", () => {
    expect(isAiConnectionSelfAuthenticatedAdapter("unknown_adapter")).toBe(false);
    expect(isAiConnectionCompatible(selection, "unknown_adapter")).toBe(false);
  });
});
