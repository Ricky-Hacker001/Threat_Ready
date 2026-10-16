/**
 * Central, configurable branding. Change these in one place.
 *
 * Product family: Aerovant Technologies -> ThreatReady.
 * This module is the AI Security Lab training range.
 * Fictional target organisation attacked inside the lab: AeroPay (a fictional
 * Indian fintech). Its fictional AI assistant is "Aero".
 *
 * Nothing here refers to a real company. AeroPay is invented for training.
 */
import logoNavy from "@/assets/aerovant-logo.png";
import logoWhite from "@/assets/aerovant-logo-white.png";

export const BRAND = {
  /** The training product name (configurable). */
  productName: "AI Security Lab",
  productShort: "AI Security Lab",

  /** Parent company + product line. */
  company: "Aerovant Technologies",
  productFamily: "ThreatReady",
  poweredByLine: "An Aerovant Technologies · ThreatReady product",

  /** The fictional organisation the learner attacks and defends. */
  targetOrg: "AeroPay",
  targetOrgDescriptor: "a fictional Indian fintech (training environment)",
  assistantName: "Aero",

  /** Asset paths (logo already background-removed to transparent PNG). */
  logoNavy,
  logoWhite,

  /** Approved, in-universe domains for AeroPay (used by allowlist scenarios). */
  approvedDomains: ["aeropay.in", "help.aeropay.in", "status.aeropay.in"],

  /** Lookalike domains attackers use in scenarios (all fictional). */
  lookalikeDomains: ["aeropay-help.co", "aeropay.in.secure-verify.co", "aero-pay.in"],
} as const;

export type Brand = typeof BRAND;
