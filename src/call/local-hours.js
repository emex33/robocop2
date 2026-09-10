/**
 * Consumer-local calling hours.
 *
 * The campaign schedule is set in the operator's zone (Amsterdam), but the
 * CRTC Unsolicited Telecommunications Rules are enforced in the CONSUMER's
 * zone: weekdays 09:00–21:30, weekends 10:00–18:00. Canada spans 4.5 hours,
 * so a 15:00 Amsterdam start is 09:00 in Toronto but 06:00 in Vancouver.
 *
 * Numbers whose area code we can't place are not gated (the campaign
 * schedule still applies to them).
 */

const TZ_BY_AREA = {
  // Pacific
  "604": "America/Vancouver", "778": "America/Vancouver", "236": "America/Vancouver",
  "672": "America/Vancouver", "250": "America/Vancouver",
  // Mountain
  "403": "America/Edmonton", "587": "America/Edmonton", "825": "America/Edmonton",
  "780": "America/Edmonton", "368": "America/Edmonton", "867": "America/Edmonton",
  // Saskatchewan (no DST)
  "306": "America/Regina", "639": "America/Regina", "474": "America/Regina",
  // Central
  "204": "America/Winnipeg", "431": "America/Winnipeg", "584": "America/Winnipeg",
  // Eastern — Ontario
  "416": "America/Toronto", "647": "America/Toronto", "437": "America/Toronto", "905": "America/Toronto",
  "289": "America/Toronto", "365": "America/Toronto", "742": "America/Toronto", "613": "America/Toronto",
  "343": "America/Toronto", "519": "America/Toronto", "226": "America/Toronto", "548": "America/Toronto",
  "705": "America/Toronto", "249": "America/Toronto", "683": "America/Toronto", "753": "America/Toronto",
  "382": "America/Toronto", "807": "America/Toronto",
  // Eastern — Quebec
  "514": "America/Toronto", "438": "America/Toronto", "263": "America/Toronto", "450": "America/Toronto",
  "579": "America/Toronto", "354": "America/Toronto", "819": "America/Toronto", "873": "America/Toronto",
  "418": "America/Toronto", "581": "America/Toronto", "367": "America/Toronto", "468": "America/Toronto",
  // Atlantic
  "902": "America/Halifax", "782": "America/Halifax", "506": "America/Halifax", "428": "America/Halifax",
  // Newfoundland
  "709": "America/St_Johns", "879": "America/St_Johns",
};

const WEEKDAY_OPEN = 9 * 60, WEEKDAY_CLOSE = 21 * 60 + 30;
const WEEKEND_OPEN = 10 * 60, WEEKEND_CLOSE = 18 * 60;

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" });
    fmtCache.set(tz, f);
  }
  return f;
}

/** IANA zone for a NANP number, or null when the area code is unknown. */
export function leadTimezone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  const ac = d.startsWith("1") ? d.slice(1, 4) : d.slice(0, 3);
  return TZ_BY_AREA[ac] || null;
}

/** Local wall-clock for a zone: { minutes since midnight, weekend } */
export function localClock(tz, at = new Date()) {
  const parts = formatter(tz).formatToParts(at).reduce((o, p) => (o[p.type] = p.value, o), {});
  const hour = Number(parts.hour) % 24; // "24" appears for midnight in some ICU builds
  return { minutes: hour * 60 + Number(parts.minute), weekend: parts.weekday === "Sat" || parts.weekday === "Sun", label: `${parts.weekday} ${String(hour).padStart(2, "0")}:${parts.minute}` };
}

/**
 * True when it is legal (and sensible) to ring this number right now.
 * Unknown area codes return true — the campaign schedule still governs them.
 */
export function isLocalCallingHour(phone, at = new Date()) {
  const tz = leadTimezone(phone);
  if (!tz) return true;
  const { minutes, weekend } = localClock(tz, at);
  return weekend
    ? minutes >= WEEKEND_OPEN && minutes < WEEKEND_CLOSE
    : minutes >= WEEKDAY_OPEN && minutes < WEEKDAY_CLOSE;
}

/** Minutes until the number becomes callable (0 if callable now, null if unknown zone). */
export function minutesUntilCallable(phone, at = new Date()) {
  const tz = leadTimezone(phone);
  if (!tz) return 0;
  const { minutes, weekend } = localClock(tz, at);
  const open = weekend ? WEEKEND_OPEN : WEEKDAY_OPEN;
  const close = weekend ? WEEKEND_CLOSE : WEEKDAY_CLOSE;
  if (minutes >= open && minutes < close) return 0;
  return minutes < open ? open - minutes : 24 * 60 - minutes + open;
}
