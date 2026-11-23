import { describe, it, expect } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { REDACT_PATHS } from "../../logging.js";

function logOnce(obj: Record<string, unknown>): Record<string, unknown> {
  let line = "";
  const sink = new Writable({
    write(chunk, _enc, cb) {
      line += chunk.toString();
      cb();
    },
  });
  pino({ redact: { paths: [...REDACT_PATHS], remove: true } }, sink).info(obj, "x");
  return JSON.parse(line) as Record<string, unknown>;
}

describe("logger redaction", () => {
  it("drops credential fields at the top level and one level deep", () => {
    const out = logOnce({
      password: "p",
      token: "t",
      secret: "s",
      cfg: { password: "p", token: "t", secret: "s", keep: 1 },
      req: { headers: { authorization: "Bearer x", cookie: "c" } },
      res: { headers: { "set-cookie": "sid=1" } },
      headers: { cookie: "c", "set-cookie": "sid=1", authorization: "Bearer x" },
    });
    expect(out).not.toHaveProperty("password");
    expect(out).not.toHaveProperty("token");
    expect(out).not.toHaveProperty("secret");
    expect(out.cfg).toEqual({ keep: 1 });
    expect(out.req).toEqual({ headers: {} });
    expect(out.res).toEqual({ headers: {} });
    expect(out.headers).toEqual({});
  });
});
