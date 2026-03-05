/**
 * Number Formatter for Voice/TTS
 *
 * Converts numeric text to natural spoken English before synthesis.
 * Applied to all TTS input so years, dates, times, and large numbers
 * read naturally instead of digit-by-digit.
 */

// ── Year: 1000–2099 → pair-split reading ──────────────────────────────
// 2024 → "twenty twenty-four", 2000 → "two thousand", 1900 → "nineteen hundred"
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
              'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
              'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function twoDigitWords(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o === 0 ? TENS[t] : `${TENS[t]}-${ONES[o]}`;
}

function yearToWords(year) {
  const y = parseInt(year, 10);
  if (y < 1000 || y > 2099) return year;

  const hi = Math.floor(y / 100);  // e.g. 20 for 2024
  const lo = y % 100;              // e.g. 24 for 2024

  // Special case: X000 → "two thousand", X100 → "twenty-one hundred"
  if (lo === 0) {
    if (hi % 10 === 0) {
      // 1000, 2000
      return `${twoDigitWords(Math.floor(hi / 10))} thousand`;
    }
    return `${twoDigitWords(hi)} hundred`;
  }

  // Normal pair-split: 1984 → "nineteen eighty-four"
  return `${twoDigitWords(hi)} ${twoDigitWords(lo)}`;
}

// ── Ordinals ──────────────────────────────────────────────────────────
function ordinal(n) {
  const suffixes = ['th','st','nd','rd'];
  const v = n % 100;
  const suffix = (v >= 11 && v <= 13) ? 'th' : (suffixes[v % 10] || 'th');
  return `${twoDigitWords(n)}${suffix}`;
}

// ── Large numbers → English ───────────────────────────────────────────
function largeNumberToWords(n) {
  if (n === 0) return 'zero';
  if (n < 0) return `negative ${largeNumberToWords(-n)}`;

  const billion  = Math.floor(n / 1_000_000_000);
  const million  = Math.floor((n % 1_000_000_000) / 1_000_000);
  const thousand = Math.floor((n % 1_000_000) / 1_000);
  const rest     = n % 1_000;

  const parts = [];
  if (billion)  parts.push(`${threeDigitWords(billion)} billion`);
  if (million)  parts.push(`${threeDigitWords(million)} million`);
  if (thousand) parts.push(`${threeDigitWords(thousand)} thousand`);
  if (rest)     parts.push(threeDigitWords(rest));
  return parts.join(' ');
}

function threeDigitWords(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts = [];
  if (h) parts.push(`${ONES[h]} hundred`);
  if (r) parts.push(twoDigitWords(r));
  return parts.join(' ');
}

// ── Month names ───────────────────────────────────────────────────────
const MONTHS = {
  january: 'January', february: 'February', march: 'March',
  april: 'April', may: 'May', june: 'June',
  july: 'July', august: 'August', september: 'September',
  october: 'October', november: 'November', december: 'December',
  jan: 'January', feb: 'February', mar: 'March', apr: 'April',
  jun: 'June', jul: 'July', aug: 'August', sep: 'September',
  oct: 'October', nov: 'November', dec: 'December',
};

// ── Main formatter ─────────────────────────────────────────────────────

/**
 * Format numbers in text for natural speech synthesis.
 * @param {string} text
 * @returns {string}
 */
export function formatNumbersForSpeech(text) {
  if (!text) return text;
  let s = text;

  // ── 1. Hex addresses / hashes — skip reading them ──────────────────
  // 0x1a2b3c → "hex address"
  s = s.replace(/\b0x[0-9a-fA-F]{4,}\b/g, 'hex address');
  // Long hex strings without 0x (SHA, MD5, etc.) — 8+ hex chars surrounded by non-alpha
  s = s.replace(/(?<![a-zA-Z0-9])[0-9a-fA-F]{8,}(?![a-zA-Z0-9])/g, 'hash value');

  // ── 2. Date patterns (before standalone year to avoid double-matching) ─
  // "February 26, 2024" or "February 26th, 2024"
  const MONTH_NAMES = Object.values(MONTHS).join('|');
  const monthDayYear = new RegExp(
    `(${MONTH_NAMES}|${Object.keys(MONTHS).filter(k => k.length > 3).map(k => k[0].toUpperCase() + k.slice(1)).join('|')})` +
    `\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`,
    'gi'
  );
  s = s.replace(monthDayYear, (_, month, day, year) => {
    const m = MONTHS[month.toLowerCase()] || month;
    return `${m} ${ordinal(parseInt(day, 10))}, ${yearToWords(year)}`;
  });

  // "26 February 2024" or "26th February 2024"
  s = s.replace(
    new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\s+(\\d{4})`, 'gi'),
    (_, day, month, year) => {
      const m = MONTHS[month.toLowerCase()] || month;
      return `${ordinal(parseInt(day, 10))} ${m} ${yearToWords(year)}`;
    }
  );

  // ISO-ish dates: 2024-02-26 or 2024/02/26
  s = s.replace(/\b(\d{4})[-/](\d{2})[-/](\d{2})\b/g, (_, y, m, d) => {
    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    const monthName = months[parseInt(m, 10) - 1] || m;
    return `${monthName} ${ordinal(parseInt(d, 10))}, ${yearToWords(y)}`;
  });

  // ── 3. Time patterns ──────────────────────────────────────────────
  // 12:34 PM, 9:05am, 23:59
  s = s.replace(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|AM|PM)?\b/g, (_, h, m, sec, ampm) => {
    const hNum = parseInt(h, 10);
    const mNum = parseInt(m, 10);
    let result = twoDigitWords(hNum === 0 ? 12 : hNum > 12 ? hNum - 12 : hNum);
    if (mNum === 0) {
      result += " o'clock";
    } else if (mNum < 10) {
      result += ` oh ${ONES[mNum]}`;
    } else {
      result += ` ${twoDigitWords(mNum)}`;
    }
    if (ampm) result += ` ${ampm.toLowerCase()}`;
    else if (hNum < 12) result += ' am';
    else result += ' pm';
    return result;
  });

  // ── 4. Standalone 4-digit years ──────────────────────────────────
  // Only years in range 1000-2099, not inside longer numbers
  s = s.replace(/(?<!\d)(1[0-9]{3}|20[0-9]{2})(?!\d)/g, (_, y) => yearToWords(y));

  // ── 5. Percentages ────────────────────────────────────────────────
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, (_, n) => {
    const num = parseFloat(n);
    if (Number.isInteger(num)) return `${largeNumberToWords(num)} percent`;
    const [intPart, decPart] = n.split('.');
    return `${largeNumberToWords(parseInt(intPart, 10))} point ${decPart.split('').map(d => ONES[parseInt(d, 10)] || 'zero').join(' ')} percent`;
  });

  // ── 6. Version numbers — read as-is (keep digits) ─────────────────
  // v2.6.0 / 2.6.0 / 14.16.2 — leave them alone, Piper handles decimals ok
  // (skip — changing these makes it worse)

  // ── 7. Large standalone numbers (≥1000, not years already handled) ──
  s = s.replace(/(?<!\d)((?:[1-9]\d{3,}|\d{1,3}(?:,\d{3})+))(?!\d)/g, (match) => {
    // Skip if already converted (contains letters)
    if (/[a-zA-Z]/.test(match)) return match;
    const n = parseInt(match.replace(/,/g, ''), 10);
    if (isNaN(n) || n > 999_999_999_999) return match;
    return largeNumberToWords(n);
  });

  // ── 8. Plain integers 0-999 (not already converted) ──────────────
  s = s.replace(/(?<!\d)(\d{1,3})(?!\d)/g, (_, n) => {
    const num = parseInt(n, 10);
    if (num > 999) return n;
    return threeDigitWords(num) || 'zero';
  });

  return s;
}
