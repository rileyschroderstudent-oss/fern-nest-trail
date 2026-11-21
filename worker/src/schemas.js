// The two output schemas, copied exactly from SPEC.md 4.6. Sent as
// output_config.format.schema. Sizes and ranges are checked in postvalidate.js.

export const QUESTIONS_SCHEMA = {
  "type": "object",
  "additionalProperties": false,
  "required": ["status", "decline_reason", "assumptions", "questions"],
  "properties": {
    "status": { "type": "string", "enum": ["ok", "declined"] },
    "decline_reason": { "type": "string", "enum": ["none", "not_travel", "unclear_destination", "unsafe_or_abusive", "other"] },
    "assumptions": { "type": "array", "items": { "type": "string" } },
    "questions": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["text", "why", "options"],
        "properties": {
          "text": { "type": "string" },
          "why": { "type": "string" },
          "options": { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  }
};

export const PLAN_SCHEMA = {
  "type": "object",
  "additionalProperties": false,
  "required": ["status", "decline_reason", "title", "route", "season_note", "flights", "days",
               "budget_items", "levers", "honest_take", "verify_before_booking", "assumptions"],
  "properties": {
    "status": { "type": "string", "enum": ["ok", "declined"] },
    "decline_reason": { "type": "string", "enum": ["none", "not_travel", "unclear_destination", "unsafe_or_abusive", "other"] },
    "title": { "type": "string" },
    "route": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["place", "nights", "area_to_stay", "area_reason", "stay_type"],
        "properties": {
          "place": { "type": "string" },
          "nights": { "type": "integer" },
          "area_to_stay": { "type": "string" },
          "area_reason": { "type": "string" },
          "stay_type": { "type": "string" }
        }
      }
    },
    "season_note": { "type": "string" },
    "flights": {
      "type": "object",
      "additionalProperties": false,
      "required": ["routing", "timing", "peak_warning"],
      "properties": {
        "routing": { "type": "string" },
        "timing": { "type": "string" },
        "peak_warning": { "type": "string" }
      }
    },
    "days": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["day", "base", "plan"],
        "properties": {
          "day": { "type": "integer" },
          "base": { "type": "string" },
          "plan": { "type": "string" }
        }
      }
    },
    "budget_items": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["category", "label", "basis", "units", "unit_low_aud", "unit_high_aud", "note"],
        "properties": {
          "category": { "type": "string", "enum": ["flights", "accommodation", "local_transport", "activities", "food", "drinks", "connectivity", "insurance", "entry_fees", "other"] },
          "label": { "type": "string" },
          "basis": { "type": "string", "enum": ["per_person", "per_group"] },
          "units": { "type": "integer" },
          "unit_low_aud": { "type": "integer" },
          "unit_high_aud": { "type": "integer" },
          "note": { "type": "string" }
        }
      }
    },
    "levers": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["change", "saves_per_person_aud"],
        "properties": {
          "change": { "type": "string" },
          "saves_per_person_aud": { "type": "integer" }
        }
      }
    },
    "honest_take": { "type": "string" },
    "verify_before_booking": { "type": "array", "items": { "type": "string" } },
    "assumptions": { "type": "array", "items": { "type": "string" } }
  }
};
