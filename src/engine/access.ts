// Access classification engine — §6.2.
// Pure TypeScript: no side effects, no DOM, testable in isolation.
// Safety-critical: read Section 6 of the spec before editing.

import type {
  AccessRule,
  ClassificationResult,
  MatchCondition,
  RulesFile,
} from "../types/access";
import { ACC_CATEGORY, ACC_DATASET, ACC_RULE_ID, ACC_RULE_NOTE } from "../types/access";

// ---------------------------------------------------------------------------
// Condition matching
// ---------------------------------------------------------------------------

function matchesCondition(
  props: Record<string, unknown>,
  cond: MatchCondition
): boolean {
  const raw = props[cond.field];
  const val  = raw === undefined || raw === null ? "" : String(raw);

  switch (cond.op) {
    case "exists":
      return val !== "";
    case "notExists":
      return val === "";
    case "eq":
      return val.toLowerCase() === String(cond.value ?? "").toLowerCase();
    case "neq":
      return val.toLowerCase() !== String(cond.value ?? "").toLowerCase();
    case "contains":
      return val.toLowerCase().includes(String(cond.value ?? "").toLowerCase());
    case "startsWith":
      return val.toLowerCase().startsWith(String(cond.value ?? "").toLowerCase());
    case "in": {
      if (!Array.isArray(cond.value)) return false;
      return cond.value.map((v) => String(v).toLowerCase()).includes(val.toLowerCase());
    }
    default:
      return false;
  }
}

function ruleMatches(props: Record<string, unknown>, rule: AccessRule): boolean {
  // All "match" conditions must pass (empty = trivially true)
  if (rule.match.length > 0) {
    if (!rule.match.every((c) => matchesCondition(props, c))) return false;
  }
  // At least one "match_any" must pass (if provided)
  if (rule.match_any && rule.match_any.length > 0) {
    if (!rule.match_any.some((c) => matchesCondition(props, c))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify one feature's properties against a merged, priority-sorted rule list.
 * Returns Unknown when no rule matches — never guesses Open.
 */
export function classifyFeature(
  props: Record<string, unknown>,
  rules: AccessRule[]
): ClassificationResult {
  // Rules are expected sorted highest-priority-first by the caller.
  for (const rule of rules) {
    if (ruleMatches(props, rule)) {
      return {
        category: rule.category,
        rule_id: rule.id,
        rule_note: rule.note,
        source_dataset: rule.source_dataset,
      };
    }
  }
  return { category: "unknown", rule_id: null, rule_note: null, source_dataset: null };
}

/**
 * Classify every feature in a FeatureCollection in-place (adds _acc_* props).
 * Returns a new FeatureCollection; original is not mutated.
 */
export function classifyFC(
  fc: GeoJSON.FeatureCollection,
  rules: AccessRule[]
): GeoJSON.FeatureCollection {
  return {
    ...fc,
    features: fc.features.map((f) => {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const result = classifyFeature(props, rules);
      return {
        ...f,
        properties: {
          ...props,
          [ACC_CATEGORY]: result.category,
          [ACC_RULE_ID]:   result.rule_id,
          [ACC_RULE_NOTE]: result.rule_note,
          [ACC_DATASET]:   result.source_dataset,
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Rules loading
// ---------------------------------------------------------------------------

/**
 * Fetch and merge rules files.
 * State rules receive a +1000 priority boost so they override national defaults.
 * Silently skips files that cannot be fetched (offline, missing, etc.).
 */
export async function loadMergedRules(
  stateScope: string | null
): Promise<AccessRule[]> {
  async function fetchRules(url: string): Promise<AccessRule[]> {
    try {
      const r = await fetch(url);
      if (!r.ok) return [];
      const rf: RulesFile = await r.json();
      return rf.rules ?? [];
    } catch {
      return [];
    }
  }

  const national = await fetchRules("/access-rules/_national.json");
  const state = stateScope ? await fetchRules(`/access-rules/${stateScope}.json`) : [];

  const merged: AccessRule[] = [
    // State rules get +1000 so they always beat national rules at the same priority
    ...state.map((r) => ({ ...r, priority: r.priority + 1000 })),
    ...national,
  ].sort((a, b) => b.priority - a.priority);

  return merged;
}

// ---------------------------------------------------------------------------
// Helpers (re-exported for convenience)
// ---------------------------------------------------------------------------

export type { AccessRule, ClassificationResult } from "../types/access";
