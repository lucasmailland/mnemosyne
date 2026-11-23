import { beforeEach, describe, expect, it, vi } from "vitest";

const postgresMock = vi.hoisted(() => {
  const reserve = vi.fn();
  const end = vi.fn().mockResolvedValue(undefined);
  const postgres = vi.fn(() => Object.assign(() => undefined, { reserve, end }));
  return { postgres, reserve, end };
});

vi.mock("postgres", () => ({ default: postgresMock.postgres }));

import { migrate } from "../migrate.js";

describe("migrate connection cleanup", () => {
  beforeEach(() => {
    postgresMock.postgres.mockClear();
    postgresMock.reserve.mockReset();
    postgresMock.end.mockClear();
  });

  it("closes the SQL client when reserving its connection fails", async () => {
    postgresMock.reserve.mockRejectedValueOnce(new Error("connection refused"));

    await expect(
      migrate({ databaseUrl: "postgres://direct/mnemo", log: () => undefined })
    ).rejects.toThrow("connection refused");

    expect(postgresMock.end).toHaveBeenCalledOnce();
  });
});
