import type { HarnessTerminalMember } from "@mnemo-ai/types";
import { computeTerminalDigest, type VisibleMessage } from "../index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type VisibleRoleIsNarrow = Assert<Equal<VisibleMessage["role"], "user" | "assistant">>;

const visibleRoleIsNarrow: VisibleRoleIsNarrow = true;
void visibleRoleIsNarrow;

declare const taskOneMembers: readonly HarnessTerminalMember[];
computeTerminalDigest(taskOneMembers);
