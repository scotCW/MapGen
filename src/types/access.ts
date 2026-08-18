// Land access classification types — Section 6 of the spec.
// Safety-critical: read Section 6 before editing.

// ---------------------------------------------------------------------------
// Five categories (§6.1)
// ---------------------------------------------------------------------------

export type CategoryId =
  | "huntable"    // Cat 1: Open — Hunting Allowed  (green)
  | "no_hunting"  // Cat 2: Open — No Hunting        (blue)
  | "closed"      // Cat 3: Closed — No Public Entry  (red)
  | "private"     // Cat 4: Private Land              (orange/tan)
  | "unknown";    // Cat 5: Unknown / Unclassified    (grey, hatch)

export interface CategoryDef {
  id: CategoryId;
  number: 1 | 2 | 3 | 4 | 5;
  label: string;
  description: string;
  color: string;
  outlineColor: string;
  fillOpacity: number;
}

export const CATEGORIES: CategoryDef[] = [
  {
    id: "huntable",
    number: 1,
    label: "Open — Hunting Allowed",
    description: "Public land you can enter and hunt on, subject to season and license",
    color: "#2e7d32",
    outlineColor: "#1b5e20",
    fillOpacity: 0.38,
  },
  {
    id: "no_hunting",
    number: 2,
    label: "Open — No Hunting",
    description: "Public land you can walk on, but hunting is prohibited",
    color: "#1565c0",
    outlineColor: "#0d47a1",
    fillOpacity: 0.38,
  },
  {
    id: "closed",
    number: 3,
    label: "Closed — No Public Entry",
    description: "Public or restricted land you may not enter at all",
    color: "#c62828",
    outlineColor: "#b71c1c",
    fillOpacity: 0.38,
  },
  {
    id: "private",
    number: 4,
    label: "Private Land",
    description: "Private property — permission required before entry",
    color: "#e65100",
    outlineColor: "#bf360c",
    fillOpacity: 0.32,
  },
  {
    id: "unknown",
    number: 5,
    label: "Unknown / Unclassified",
    description: "Access status could not be determined from available data",
    color: "#757575",
    outlineColor: "#424242",
    fillOpacity: 0.22,
  },
];

export const CATEGORY_MAP = new Map<CategoryId, CategoryDef>(
  CATEGORIES.map((c) => [c.id, c])
);

// ---------------------------------------------------------------------------
// Rules engine types (§6.2)
// ---------------------------------------------------------------------------

export type MatchOp =
  | "eq"          // field === value (case-insensitive)
  | "neq"         // field !== value
  | "contains"    // field includes value substring
  | "startsWith"  // field starts with value
  | "in"          // field is one of value[]
  | "exists"      // field is non-empty
  | "notExists";  // field is empty / absent

export interface MatchCondition {
  field: string;
  op: MatchOp;
  value?: string | string[] | number | boolean;
}

export interface AccessRule {
  id: string;
  category: CategoryId;
  /** Human-readable name of the source dataset. */
  source_dataset: string;
  /** Plain-English explanation of why this rule assigns this category. */
  note: string;
  /** Higher numbers are evaluated first. State rules receive a +1000 boost. */
  priority: number;
  /** ALL conditions must match (empty array = always passes). */
  match: MatchCondition[];
  /** At least ONE must match (only required when provided). */
  match_any?: MatchCondition[];
}

export interface RulesFile {
  version: number;
  scope: string;
  description: string;
  rules: AccessRule[];
}

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  category: CategoryId;
  rule_id: string | null;
  rule_note: string | null;
  source_dataset: string | null;
}

// GeoJSON property names added to classified features
export const ACC_CATEGORY   = "_acc_category"   as const;
export const ACC_RULE_ID    = "_acc_rule_id"    as const;
export const ACC_RULE_NOTE  = "_acc_rule_note"  as const;
export const ACC_DATASET    = "_acc_dataset"    as const;

// ---------------------------------------------------------------------------
// Mandatory disclaimer text (§6.3)
// ---------------------------------------------------------------------------

export const ACCESS_DISCLAIMER =
  "Land access shown is approximate and derived from public datasets. " +
  "It is for planning only and is not legal authority. " +
  "Boundaries may be inaccurate and access status changes. " +
  "Verify current regulations, closures, and land status with CPW / WGFD " +
  "and the managing agency before hunting.";

export const ACCESS_NOTE =
  "Access categories are estimates — verify before you hunt.";

/** localStorage key for the one-time first-run acknowledgment. */
export const ACCESS_ACK_KEY = "access_disclaimer_ack_v1";
