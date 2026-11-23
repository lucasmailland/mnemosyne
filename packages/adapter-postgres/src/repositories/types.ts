import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index.js';

export type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;
export type DekUnwrapper = (workspaceId: string, actorId: string, wrappedDek: string) => Buffer;
export type DekProvisioner = (workspaceId: string, actorId: string) => { dek: Buffer; wrapped: string };
