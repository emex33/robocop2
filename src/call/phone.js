/**
 * Dialable E.164-ish digits. Strips doubled DE/ES country codes
 * (494915… → 4915…, 34346… → 346…).
 */
const COUNTRY_CODES = ["49", "34"];

export function normalizeDialPhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "").replace(/^00+/, "");
  if (!digits) return "";
  for (const cc of COUNTRY_CODES) {
    const doubled = cc + cc;
    while (digits.startsWith(doubled)) {
      const next = digits.slice(cc.length);
      if (next.length < 8 || next.length > 15) break;
      digits = next;
    }
  }
  return digits;
}
