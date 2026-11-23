import { expectTypeOf } from "vitest";
import type { StorageAdapter } from "../ports.js";

// appendMeterEvent must accept a structural meter event and return Promise<void>.
expectTypeOf<NonNullable<StorageAdapter["appendMeterEvent"]>>().parameter(0).toMatchTypeOf<{
  workspaceId: string;
  metric: string;
  quantity: number;
  occurredAt: Date;
  costUsd: number;
  idempotencyKey: string;
}>();

// getMonthToDateUsageFromDb returns a per-metric numeric map.
expectTypeOf<NonNullable<StorageAdapter["getMonthToDateUsageFromDb"]>>()
  .returns.resolves.toMatchTypeOf<Record<string, number>>();

// getWorkspaceMonthlySpendUsd already exists and returns Promise<number>.
expectTypeOf<NonNullable<StorageAdapter["getWorkspaceMonthlySpendUsd"]>>()
  .returns.resolves.toBeNumber();
