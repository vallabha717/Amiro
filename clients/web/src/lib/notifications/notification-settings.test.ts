import { describe, expect, it } from "vitest";
import { mergeSettings, normalizeSettings } from "./notification-types";

describe("mergeSettings", () => {
  it("turns a switch back on after it was turned off", () => {
    const off = mergeSettings(normalizeSettings({}), { soundEnabled: false });
    expect(off.soundEnabled).toBe(false);
    expect(off.notificationSoundChime).toBe(false);
    const on = mergeSettings(off, { soundEnabled: true });
    expect(on.soundEnabled).toBe(true);
    expect(on.notificationSoundChime).toBe(true);
  });

  it("does the same for every setting that has a legacy alias", () => {
    const off = mergeSettings(normalizeSettings({}), {
      enabled: false,
      allAlertsEnabled: false,
      scheduleAlerts: false,
    });
    const on = mergeSettings(off, { enabled: true, allAlertsEnabled: true, scheduleAlerts: true });
    expect(on.enabled).toBe(true);
    expect(on.allAlertsEnabled).toBe(true);
    expect(on.scheduleAlerts).toBe(true);
  });

  it("still honours a legacy alias sent in the change itself", () => {
    const on = normalizeSettings({});
    expect(mergeSettings(on, { notificationSoundChime: false }).soundEnabled).toBe(false);
  });
});
