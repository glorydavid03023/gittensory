// PreToolUse-style deny-hook primitives (#2295). Now a thin re-export of the engine's pure, deterministic deny
// evaluator: the whole implementation moved into `@loopover/engine` (packages/loopover-engine/src/miner/
// deny-hooks.ts) by #5667 so the review stack and the miner share one copy. No behavior change — the evaluator is
// pure (no IO, no globals, no Date/random). Types (DenyRule/DenyVerdict/ProposedToolCall) come from the same
// engine module so the miner package's public contract stays identical after the TypeScript migration.

export {
  DEFAULT_DENY_RULES,
  evaluateDenyHooks,
  type DenyRule,
  type DenyVerdict,
  type ProposedToolCall,
} from "@loopover/engine";
