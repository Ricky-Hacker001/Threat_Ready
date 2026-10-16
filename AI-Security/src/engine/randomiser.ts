/** Per-attempt randomisation. Deterministic given the seed. */
import { Rng } from "./rng";
import type { AttemptSecrets, SyntheticCustomer } from "./types";
import {
  CITIES,
  DISCOUNT_CODES,
  FIRST_NAMES,
  INTERNAL_API_NAMES,
  LAST_NAMES,
} from "@/data/pools";

export function makeSecrets(rng: Rng): AttemptSecrets {
  return {
    canary: `TP-CANARY-${rng.token(4)}`,
    discountCode: `${rng.pick(DISCOUNT_CODES)}-${rng.token(3)}`,
    internalApi: rng.pick(INTERNAL_API_NAMES),
    escalationPhone: `+91 ${rng.int(70000, 99999)} ${rng.int(10000, 99999)}`,
    poisonedDocId: `DOC-${rng.int(100, 999)}`,
    maliciousPluginId: `PLG-${rng.int(1, 8)}`,
  };
}

function maskedPan(rng: Rng): string {
  // Masked only — never a real PAN. Format: XXXXX####X
  return `XXXXX${rng.int(1000, 9999)}${String.fromCharCode(65 + rng.int(0, 25))}`;
}

export function makeCustomers(rng: Rng, n: number): SyntheticCustomer[] {
  const out: SyntheticCustomer[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `CUST-${10000 + i}`,
      name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
      phone: `+91 ${rng.int(70000, 99999)}${rng.int(10000, 99999)}`,
      maskedPan: maskedPan(rng),
      balance: rng.int(500, 250000),
      city: rng.pick(CITIES),
    });
  }
  return out;
}
