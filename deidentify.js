// ============================================================
// DE-IDENTIFICATION — HIPAA Safe Harbor scrubbing for Slack
// ============================================================
// Slack does not have a BAA on standard plans. Any PHI flowing
// to Slack is a §164.502(e) violation. This module reduces
// patient identifiers to forms acceptable under §164.514(b)(2)
// Safe Harbor de-identification.
//
// Rules per channel:
//  - #claude-pipeline-manager: First name + last initial, no clinical detail
//  - #evaluations-scheduled:   Initials only + appointment time + clinical summary
//  - #deals-board-conversions: Initials only + outcome
//
// Phone numbers are always reduced to area code + last 2 digits
// (e.g. "+1 626-***-**42") which is not a HIPAA identifier on its
// own once name + DOB + other identifiers are stripped.
//
// Full PHI continues to flow to GHL, the financial dashboard
// sheet, and email — all of which have BAAs in place.
// ============================================================

/**
 * "Sarah Martinez" → "Sarah M."
 * Used for #claude-pipeline-manager (no clinical content alongside)
 */
function firstNameLastInitial(fullName) {
  if (!fullName || typeof fullName !== 'string') return 'Unknown';
  const cleaned = fullName.trim();
  if (!cleaned || cleaned.toLowerCase() === 'unknown') return 'Unknown';
  // Strip known placeholder patterns
  if (/incoming call/i.test(cleaned)) return 'Unknown';

  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Unknown';
  const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
  if (parts.length === 1) return first;
  const lastInit = parts[parts.length - 1].charAt(0).toUpperCase();
  return `${first} ${lastInit}.`;
}

/**
 * "Sarah Martinez" → "S.M."
 * Used everywhere clinical detail is also being included.
 */
function initials(fullName) {
  if (!fullName || typeof fullName !== 'string') return 'Unknown';
  const cleaned = fullName.trim();
  if (!cleaned || cleaned.toLowerCase() === 'unknown') return 'Unknown';
  if (/incoming call/i.test(cleaned)) return 'Unknown';

  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Unknown';
  if (parts.length === 1) return `${parts[0].charAt(0).toUpperCase()}.`;
  const f = parts[0].charAt(0).toUpperCase();
  const l = parts[parts.length - 1].charAt(0).toUpperCase();
  return `${f}.${l}.`;
}

/**
 * "+16265551234" → "+1 626-***-**34"
 * Keeps area code + last 2 digits — enough for the team to recognize
 * the phone without it being a HIPAA-protected identifier on its own.
 */
function redactPhone(phone) {
  if (!phone || typeof phone !== 'string') return 'Unknown';
  // Strip all non-digits
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return '****';
  // For US numbers: +1 (XXX) XXX-XXXX
  // Show: +1 XXX-***-**XX
  const last10 = digits.slice(-10);
  const area = last10.slice(0, 3);
  const last2 = last10.slice(-2);
  return `+1 ${area}-***-**${last2}`;
}

/**
 * Builds a sanitized clinical summary line from Claude's structured output.
 *
 * Claude already extracts a clinical_summary object with fields:
 *   problem_areas, symptom_duration, prior_care, goals,
 *   plan_of_care_discussed, objections
 *
 * These are clinical content, not identifiers — safe to ship to Slack
 * once paired with initials-only (no name, no phone, no DOB).
 *
 * Returns null if the summary is empty/missing — caller should omit
 * the clinical block in that case.
 */
function buildClinicalLine(clinicalSummary) {
  if (!clinicalSummary || typeof clinicalSummary !== 'object') return null;
  const cs = clinicalSummary;
  const parts = [];
  if (cs.problem_areas && cs.problem_areas !== 'null') {
    parts.push(cs.problem_areas);
  }
  if (cs.symptom_duration && cs.symptom_duration !== 'null') {
    parts.push(`(${cs.symptom_duration})`);
  }
  if (cs.goals && cs.goals !== 'null') {
    parts.push(`Goal: ${cs.goals}`);
  }
  if (cs.prior_care && cs.prior_care !== 'null') {
    parts.push(`Prior care: ${cs.prior_care}`);
  }
  if (parts.length === 0) return null;
  return parts.join(' · ');
}

/**
 * Strip name occurrences from a freeform note/summary string.
 *
 * Claude's call summaries often include the patient's name inline
 * ("Sarah called about her knee..."). This pass scrubs the supplied
 * fullName from the text. Best-effort; the structured de-id paths
 * (initials + clinical_summary) are the primary defense.
 */
function scrubNameFromText(text, fullName) {
  if (!text || !fullName) return text || '';
  const parts = fullName.trim().split(/\s+/).filter(p => p.length >= 2);
  let out = text;
  for (const part of parts) {
    // Word-boundary case-insensitive replacement
    const re = new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(re, '[patient]');
  }
  return out;
}

module.exports = {
  firstNameLastInitial,
  initials,
  redactPhone,
  buildClinicalLine,
  scrubNameFromText
};
