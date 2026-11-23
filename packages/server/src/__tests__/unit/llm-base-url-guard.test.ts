import { describe, expect, it } from "vitest";

import { checkWorkspaceBaseUrl, isNonPublicAddress } from "../../config/llm-base-url-guard.js";

const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address }));

describe("isNonPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:1",
  ])("%s is not public", (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"])(
    "%s is public",
    (address) => {
      expect(isNonPublicAddress(address)).toBe(false);
    }
  );
});

describe("checkWorkspaceBaseUrl", () => {
  it("accepts an https host that resolves only to public addresses", async () => {
    expect(
      await checkWorkspaceBaseUrl("https://api.example.com/v1", resolvesTo("93.184.216.34"))
    ).toBeNull();
  });

  it("refuses a host whose DNS answer includes a private address", async () => {
    expect(
      await checkWorkspaceBaseUrl(
        "https://internal.example.com",
        resolvesTo("93.184.216.34", "10.0.0.5")
      )
    ).toBe("BASE_URL_PRIVATE_ADDRESS");
  });

  it("refuses a host that does not resolve", async () => {
    const fails = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await checkWorkspaceBaseUrl("https://nowhere.invalid", fails)).toBe(
      "BASE_URL_UNRESOLVABLE"
    );
  });

  it("refuses plain http, a non-URL and *.localhost without a DNS lookup", async () => {
    const neverCalled = async () => {
      throw new Error("lookup must not run");
    };
    expect(await checkWorkspaceBaseUrl("http://api.example.com", neverCalled)).toBe(
      "BASE_URL_NOT_HTTPS"
    );
    expect(await checkWorkspaceBaseUrl("not a url", neverCalled)).toBe("BASE_URL_INVALID");
    expect(await checkWorkspaceBaseUrl("https://app.localhost/v1", neverCalled)).toBe(
      "BASE_URL_PRIVATE_ADDRESS"
    );
  });
});
