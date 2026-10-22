import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Logger } from "@nestjs/common";
import { Reader } from "mmdb-lib";

/**
 * Country from an IP address, fully offline: the CC0 "GeoFeed + Whois + ASN" country database
 * (@ip-location-db/geo-whois-asn-country-mmdb, IPv4 + IPv6, ~8 MB) read in-process. No third
 * party ever sees a user's IP, and only the country is stored, never the address.
 *
 * Refreshing the data: the npm package is no longer updated upstream; newer files come from
 * https://github.com/sapics/ip-location-db/releases (same format). Set GEO_COUNTRY_MMDB to a
 * newer file to use it without a code change.
 */
const logger = new Logger("Geo");
// The file's records are { country_code }; mmdb-lib types its generic as the MaxMind response shapes.
type Rec = { country_code?: string };
let reader: Reader<any> | null | undefined;

function open(): Reader<any> | null {
  if (reader !== undefined) return reader;
  try {
    const file =
      process.env.GEO_COUNTRY_MMDB ||
      createRequire(import.meta.url).resolve("@ip-location-db/geo-whois-asn-country-mmdb/geo-whois-asn-country.mmdb");
    reader = new Reader(readFileSync(file));
  } catch (err) {
    logger.warn(`country database unavailable, locations will show as unknown: ${(err as Error).message}`);
    reader = null;
  }
  return reader;
}

const PRIVATE_V4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** ISO 3166-1 alpha-2 country, "LO" for a local/private network, "ZZ" when unknown. */
export function countryOf(ip: string | undefined | null): string {
  if (!ip) return "ZZ";
  const addr = ip.trim().replace(/^::ffff:/i, "");
  if (addr === "::1" || PRIVATE_V4.test(addr) || /^f[cd][0-9a-f]{2}:/i.test(addr) || /^fe80:/i.test(addr)) return "LO";
  try {
    const code = (open()?.get(addr) as Rec | null | undefined)?.country_code;
    return code && /^[A-Z]{2}$/.test(code) ? code : "ZZ";
  } catch {
    return "ZZ";
  }
}
