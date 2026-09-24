import { describe, expect, it } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry, { directSenderFromSessionKey, trustedIdentity } from "./index.js";

describe("rainbow-cats", () => {
  it("declares only the four Rainbow-Cats tools", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual([
      "rainbow_link",
      "rainbow_context",
      "rainbow_propose",
      "rainbow_confirm",
    ]);
  });

  it("does not let the model supply trusted WeChat identity fields", () => {
    const tools = getToolPluginMetadata(entry)?.tools ?? [];
    for (const tool of tools) {
      const properties = Object.keys(tool.parameters.properties ?? {});
      expect(properties).not.toContain("channel");
      expect(properties).not.toContain("agentAccountId");
      expect(properties).not.toContain("requesterSenderId");
    }
  });

  it("recovers a sender only from a matching direct-chat session key", () => {
    const context = {
      agentId: "main",
      messageChannel: "openclaw-weixin",
      agentAccountId: "ai-account",
      sessionKey: "agent:main:openclaw-weixin:ai-account:direct:sender-a",
    };
    expect(directSenderFromSessionKey(context)).toBe("sender-a");
    expect(directSenderFromSessionKey({ ...context, sessionKey: "agent:main:openclaw-weixin:ai-account:group:sender-a" })).toBe("");
    expect(directSenderFromSessionKey({ ...context, agentId: "xiaonuan" })).toBe("");
    expect(directSenderFromSessionKey({ ...context, agentAccountId: "other-account" })).toBe("");
  });

  it("rejects untrusted contexts while accepting the strict session fallback", () => {
    const previous = process.env.RAINBOW_CATS_AGENT_ACCOUNT_IDS;
    process.env.RAINBOW_CATS_AGENT_ACCOUNT_IDS = "ai-account";
    try {
      expect(trustedIdentity({
        agentId: "main",
        messageChannel: "openclaw-weixin",
        agentAccountId: "ai-account",
        sessionKey: "agent:main:openclaw-weixin:ai-account:direct:sender-a",
      })).toEqual({
        channel: "openclaw-weixin",
        agentAccountId: "ai-account",
        requesterSenderId: "sender-a",
        agentLabel: "AI_1",
      });
      expect(trustedIdentity({
        agentId: "main",
        messageChannel: "other-channel",
        agentAccountId: "ai-account",
        sessionKey: "agent:main:other-channel:ai-account:direct:sender-a",
      })).toBeNull();
      expect(trustedIdentity({
        agentId: "main",
        messageChannel: "openclaw-weixin",
        agentAccountId: "other-account",
        sessionKey: "agent:main:openclaw-weixin:other-account:direct:sender-a",
      })).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.RAINBOW_CATS_AGENT_ACCOUNT_IDS;
      else process.env.RAINBOW_CATS_AGENT_ACCOUNT_IDS = previous;
    }
  });
});
