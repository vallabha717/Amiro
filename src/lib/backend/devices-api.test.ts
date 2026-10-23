import { describe, expect, it } from "vitest";
import {
  guessPlatform,
  parsePairingInput,
  serverAddressAllowed,
} from "./devices-api";

describe("parsePairingInput", () => {
  it("reads the server and code from a scanned pairing link", () => {
    expect(
      parsePairingInput("http://192.168.1.5:8790/pair?code=ABCD-EFGH"),
    ).toEqual({ server: "http://192.168.1.5:8790", code: "ABCD-EFGH" });
  });

  it("accepts a bare address and adds http://", () => {
    expect(parsePairingInput(" 192.168.1.5:8790/ ")).toEqual({
      server: "http://192.168.1.5:8790",
      code: null,
    });
    expect(parsePairingInput("https://amiro.example.com").server).toBe(
      "https://amiro.example.com",
    );
  });

  it("rejects empty input and non-web schemes", () => {
    expect(parsePairingInput("")).toEqual({ server: null, code: null });
    expect(parsePairingInput("ftp://host").server).toBeNull();
  });
});

describe("guessPlatform", () => {
  it("tells phones from the desktop app and browsers", () => {
    expect(guessPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", false)).toBe("ios");
    expect(guessPlatform("Mozilla/5.0 (Linux; Android 15; Pixel 9)", false)).toBe("android");
    expect(guessPlatform("Mozilla/5.0 (X11; Linux x86_64)", true)).toBe("desktop");
    expect(guessPlatform("Mozilla/5.0 (X11; Linux x86_64)", false)).toBe("web");
  });
});

describe("serverAddressAllowed", () => {
  it("needs https over the internet", () => {
    expect(serverAddressAllowed("https://amiro.example.com")).toBe(true);
    expect(serverAddressAllowed("http://amiro.example.com")).toBe(false);
    expect(serverAddressAllowed("http://8.8.8.8:8790")).toBe(false);
  });

  it("allows plain http on your own network", () => {
    for (const ok of [
      "http://192.168.1.5:8790",
      "http://10.0.0.2:8790",
      "http://172.20.1.1:8790",
      "http://100.101.102.103:8790",
      "http://127.0.0.1:8787",
      "http://localhost:3000",
      "http://my-mac.local:8790",
      "http://my-vm.tail1234.ts.net:8787",
    ]) {
      expect(serverAddressAllowed(ok), ok).toBe(true);
    }
    expect(serverAddressAllowed("http://172.32.0.1")).toBe(false);
    expect(serverAddressAllowed("ftp://192.168.1.5")).toBe(false);
  });
});
