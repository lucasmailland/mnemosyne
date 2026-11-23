// flatten-legacy-dual-core PR9f (design.md D6.5) — barrel for the pure-core
// graph traversal/pathfinding functions. See traverse.ts for the algorithm
// and the cardinal hexagonal-purity rule this directory must uphold.

export { traverseGraph, findGraphPath } from "./traverse.js";
export type {
  GraphTraverseDeps,
  TraverseGraphOptions,
  TraverseGraphHit,
  GraphPathOptions,
  GraphPathEdge,
  GraphPathResult,
} from "./traverse.js";
