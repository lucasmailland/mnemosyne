/**
 * APP-005 (audit 2026-11-22): a key with memory:write registered a webhook to
 * http://ollama:11434/api/tags and POST /webhooks/:id/test returned the internal
 * service's response body; http://169.254.169.254/latest/meta-data/ was accepted
 * too. A webhook is a request the server makes on someone's behalf: it may only
 * go where that someone could have gone themselves.
 */
import { describe, expect, it } from "vitest";

import { checkWebhookUrl, isBlockedAddress, webhookUrlPolicyFromEnv } from "../../webhook-url-guard.js";

const STRICT = { allowHttp: false, allowPrivate: false };
const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
const unresolvable = async () => {
  throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
};

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", "127.8.9.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.10",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  // Re-audit 2026-11-22: an IPv6 address that carries an IPv4 one inside it
  // (IPv4-compatible ::a.b.c.d, the hex form the URL parser writes, 6to4
  // 2002::/16) is judged by that IPv4 address.
  it.each([
    "::127.0.0.1", "::7f00:1", "::a9fe:a9fe", "::ffff:7f00:1", "::ffff:a00:1",
    "2002:7f00:1::", "2002:a9fe:a9fe::1", "2002:c0a8:101:1::1",
  ])("blocks %s, which embeds an internal IPv4 address", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["2002:5db8:d822::1", "::ffff:5db8:d822"])(
    "allows %s, which embeds a public IPv4 address",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  );

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:2800:220:1:248:1893:25c8:1946"])(
    "allows %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  );
});

describe("checkWebhookUrl", () => {
  it("accepts an https URL that resolves to a public address", async () => {
    expect(
      await checkWebhookUrl("https://hooks.example.com/x", { policy: STRICT, lookup: resolvesTo("93.184.216.34") })
    ).toEqual({ ok: true });
  });

  it("refuses plain http unless the operator allowed it", async () => {
    const res = await checkWebhookUrl("http://hooks.example.com/x", { policy: STRICT, lookup: resolvesTo("93.184.216.34") });
    expect(res).toMatchObject({ ok: false, reason: "must_be_https" });
    expect(
      await checkWebhookUrl("http://hooks.example.com/x", {
        policy: { allowHttp: true, allowPrivate: false },
        lookup: resolvesTo("93.184.216.34"),
      })
    ).toEqual({ ok: true });
  });

  it.each([
    "https://127.0.0.1/x", "https://[::1]:8443/x", "https://169.254.169.254/latest/meta-data/",
    "https://10.1.2.3/x", "https://localhost/x", "https://db.localhost/x", "https://2130706433/x",
    "https://0x7f.0.0.1/x", "https://[::127.0.0.1]/x", "https://[2002:a9fe:a9fe::]/latest/meta-data/",
  ])("refuses the literal internal target %s without asking DNS", async (url) => {
    const res = await checkWebhookUrl(url, { policy: STRICT, lookup: unresolvable });
    expect(res).toMatchObject({ ok: false, reason: "private_address" });
  });

  it("refuses a public-looking name that resolves to an internal address", async () => {
    const res = await checkWebhookUrl("https://ollama.attacker.example/api/tags", {
      policy: STRICT,
      lookup: resolvesTo("172.18.0.4"),
    });
    expect(res).toMatchObject({ ok: false, reason: "private_address" });
  });

  it("refuses when ANY resolved address is internal", async () => {
    const res = await checkWebhookUrl("https://mixed.example/x", {
      policy: STRICT,
      lookup: resolvesTo("93.184.216.34", "10.0.0.9"),
    });
    expect(res).toMatchObject({ ok: false, reason: "private_address" });
  });

  it("does not refuse a name that cannot be resolved right now: the delivery fails on its own", async () => {
    expect(await checkWebhookUrl("https://not-yet.example/x", { policy: STRICT, lookup: unresolvable })).toEqual({
      ok: true,
    });
  });

  it("refuses credentials in the URL and anything that is not http(s)", async () => {
    expect(await checkWebhookUrl("https://user:pw@hooks.example.com/x", { policy: STRICT, lookup: resolvesTo("93.184.216.34") })).toMatchObject({ ok: false, reason: "credentials_in_url" });
    expect(await checkWebhookUrl("file:///etc/passwd", { policy: STRICT, lookup: unresolvable })).toMatchObject({ ok: false, reason: "must_be_https" });
    expect(await checkWebhookUrl("not a url", { policy: STRICT, lookup: unresolvable })).toMatchObject({ ok: false, reason: "invalid_url" });
  });

  it("lets an operator who runs internal receivers opt in", async () => {
    expect(
      await checkWebhookUrl("http://n8n.internal:5678/hook", {
        policy: { allowHttp: true, allowPrivate: true },
        lookup: resolvesTo("10.0.0.9"),
      })
    ).toEqual({ ok: true });
  });
});

describe("webhookUrlPolicyFromEnv", () => {
  it("is strict by default and reads the two opt-ins", () => {
    expect(webhookUrlPolicyFromEnv({})).toEqual(STRICT);
    expect(
      webhookUrlPolicyFromEnv({ MNEMO_WEBHOOK_ALLOW_HTTP: "true", MNEMO_WEBHOOK_ALLOW_PRIVATE: "true" })
    ).toEqual({ allowHttp: true, allowPrivate: true });
    expect(webhookUrlPolicyFromEnv({ MNEMO_WEBHOOK_ALLOW_HTTP: "1" })).toEqual(STRICT);
  });
});
