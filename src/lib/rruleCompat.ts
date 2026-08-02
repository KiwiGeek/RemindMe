/**
 * `rrule` ships dual CJS/ESM without a proper `exports` map. Node's native ESM
 * loader (and some tsx paths) expose it as `{ default: { RRule, … } }`, while
 * bundlers (Workers / Vitest) expose named exports. Resolve either shape.
 */

import * as rruleNs from 'rrule';

type RRuleCtor = typeof import('rrule').RRule;

function resolveRRule(): RRuleCtor {
  const ns = rruleNs as {
    RRule?: RRuleCtor;
    default?: { RRule?: RRuleCtor };
  };
  const ctor = ns.RRule ?? ns.default?.RRule;
  if (!ctor) {
    throw new Error('rrule: RRule export not found (CJS/ESM interop)');
  }
  return ctor;
}

export const RRule = resolveRRule();
