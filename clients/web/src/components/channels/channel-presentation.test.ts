import { describe, expect, it } from "vitest";
import { getChannelLabel } from "./channel-presentation";

describe("channels and contacts presentation", () => {
  it("resolves channel display labels correctly", () => {
    expect(getChannelLabel("slack")).toBe("Slack");
    expect(getChannelLabel("telegram")).toBe("Telegram");
    expect(getChannelLabel("discord")).toBe("Discord");
    expect(getChannelLabel("phone")).toBe("Phone Calling");
    expect(getChannelLabel("email")).toBe("Email");
    expect(getChannelLabel("whatsapp")).toBe("WhatsApp");
    expect(getChannelLabel("a2a")).toBe("Assistant");
    expect(getChannelLabel("custom-channel")).toBe("Custom-channel");
    expect(getChannelLabel(null)).toBe("Channel");
  });
});
