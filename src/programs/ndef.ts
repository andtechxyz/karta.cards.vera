import { getConfig } from '../config.js';

// -----------------------------------------------------------------------------
// NDEF URL templates.
//
// The card's NDEF file contains a URL that gets emitted on tap.  We store
// two templates per Program:
//
//   preActivationNdefUrlTemplate  — written at perso time; first tap hits
//                                   Vera's /activate/:cardRef SUN handler.
//   postActivationNdefUrlTemplate — written by Palisade after successful
//                                   WebAuthn registration; subsequent taps
//                                   hit the payment-initiation flow.
//
// Placeholder substitution happens at two separate layers:
//
//   {cardRef}               — substituted by Vera here, before handing the
//                             URL to Palisade.
//   {PICCData}  / {CMAC}    — literal markers the NXP SDM engine substitutes
//                             on-card per tap.  Vera must pass them through
//                             the template verbatim; any other placeholder
//                             that resembles those markers would corrupt the
//                             SUN URL the card emits.
//
// When a Program doesn't set one or both templates, we fall back to defaults
// derived from WEBAUTHN_ORIGIN so the prototype's single-deployment flow
// works without any admin configuration.
// -----------------------------------------------------------------------------

/** Markers the card's SDM engine fills in at tap time — must survive rendering. */
const SDM_MARKERS = ['{PICCData}', '{CMAC}'] as const;

export interface NdefUrlPair {
  preActivation: string;
  postActivation: string;
}

export interface RenderNdefInput {
  cardRef: string;
  preActivationTemplate?: string | null;
  postActivationTemplate?: string | null;
}

export function renderNdefUrls(input: RenderNdefInput): NdefUrlPair {
  const origin = getConfig().WEBAUTHN_ORIGIN;
  const pre =
    input.preActivationTemplate ??
    `${origin}/activate/{cardRef}?e={PICCData}&m={CMAC}`;
  const post =
    input.postActivationTemplate ??
    `${origin}/tap/{cardRef}?e={PICCData}&m={CMAC}`;
  return {
    preActivation: substituteCardRef(pre, input.cardRef),
    postActivation: substituteCardRef(post, input.cardRef),
  };
}

/**
 * Replace `{cardRef}` in a template while leaving SDM markers untouched.
 * A plain string replace is sufficient: SDM markers are distinct tokens and
 * don't overlap with `{cardRef}`.
 */
function substituteCardRef(template: string, cardRef: string): string {
  return template.replaceAll('{cardRef}', cardRef);
}

/**
 * Shape check for an NDEF URL template.  Accepts http(s) URLs, requires the
 * {cardRef} placeholder, and rejects stray curly-brace tokens outside the
 * known allowlist so typos like `{cardref}` or `{card_ref}` fail loud.
 */
export function validateNdefUrlTemplate(template: string): void {
  if (!/^https?:\/\//i.test(template)) {
    throw new Error(`NDEF URL template must be http(s): got "${template}"`);
  }
  if (!template.includes('{cardRef}')) {
    throw new Error(`NDEF URL template must contain {cardRef}: "${template}"`);
  }
  const tokens = template.match(/\{[^}]+\}/g) ?? [];
  const allowed = new Set<string>(['{cardRef}', ...SDM_MARKERS]);
  for (const tok of tokens) {
    if (!allowed.has(tok)) {
      throw new Error(
        `NDEF URL template contains unknown placeholder ${tok}; allowed: {cardRef}, {PICCData}, {CMAC}`,
      );
    }
  }
}
