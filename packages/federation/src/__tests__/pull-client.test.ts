import { describe, it, expect, vi, afterEach } from "vitest";
import { pullFromPeer, MAX_PULL_RESPONSE_BYTES } from "../PullClient.js";

describe("pullFromPeer", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches items from the remote peer", async () => {
    const mockItems = [
      {
        remoteId: "fact-1",
        version: 2,
        peerDomain: "peer.example.com",
        payload: { statement: "The sky is blue." },
      },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: mockItems, nextCursor: null }),
    } as unknown as Response);

    const result = await pullFromPeer("https://peer.example.com", "test-key");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.remoteId).toBe("fact-1");
    expect(result.nextCursor).toBeNull();

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(fetchCall[0]).toContain("/memory/federation/items");
    expect(fetchCall[1].headers.Authorization).toBe("Bearer test-key");
  });

  it("includes since parameter when provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], nextCursor: null }),
    } as unknown as Response);

    await pullFromPeer("https://peer.example.com", "key", { since: "2025-01-01T00:00:00Z" });
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain("since=2025-01-01T00%3A00%3A00Z");
  });

  it("throws on non-OK response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    } as unknown as Response);

    await expect(pullFromPeer("https://peer.example.com", "bad-key")).rejects.toThrow("403");
  });

  it("includes nextCursor when more pages exist", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], nextCursor: "2025-06-14T10:00:00Z" }),
    } as unknown as Response);

    const result = await pullFromPeer("https://peer.example.com", "key");
    expect(result.nextCursor).toBe("2025-06-14T10:00:00Z");
  });

  it("refuses a response declared bigger than the cap", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": String(MAX_PULL_RESPONSE_BYTES + 1) }),
      json: async () => ({ items: [] }),
    } as unknown as Response);
    await expect(pullFromPeer("https://peer.example.com", "key")).rejects.toThrow("exceeds");
  });

  it("stops reading a streamed response once it passes the cap", async () => {
    const mb = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += mb.byteLength;
        controller.enqueue(mb);
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(body));
    await expect(pullFromPeer("https://peer.example.com", "key")).rejects.toThrow("exceeds");
    expect(sent).toBeLessThan(MAX_PULL_RESPONSE_BYTES + 4 * mb.byteLength);
  });
});
