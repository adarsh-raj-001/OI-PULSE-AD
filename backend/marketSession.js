const TIME_ZONE = 'Asia/Kolkata';
const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

function partsAt(timestamp, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function timeToMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Resolves the optional OI Pulse market-session pause. It intentionally models
 * the user's selected weekday policy rather than exchange holidays or special
 * sessions; turning the rule off remains the manual override for those cases.
 */
export function resolveMarketSession({ enabled, opensAt = '09:15', closesAt = '15:30', timestamp = Date.now(), timeZone = TIME_ZONE } = {}) {
  const openMinutes = timeToMinutes(opensAt);
  const closeMinutes = timeToMinutes(closesAt);
  if (openMinutes === null || closeMinutes === null || closeMinutes <= openMinutes) throw new Error('Market session must use valid increasing HH:MM times.');
  const local = partsAt(timestamp, timeZone);
  const minutes = Number(local.hour) * 60 + Number(local.minute);
  const isWeekday = WEEKDAYS.has(local.weekday);
  const isWithinHours = isWeekday && minutes >= openMinutes && minutes < closeMinutes;
  const active = enabled !== true || isWithinHours;
  const reason = enabled !== true ? 'manual-override' : !isWeekday ? 'weekend' : minutes < openMinutes ? 'before-open' : minutes >= closeMinutes ? 'after-close' : 'open';
  return {
    enabled: enabled === true,
    active,
    reason,
    timeZone,
    opensAt,
    closesAt,
    localWeekday: local.weekday,
    localTime: `${local.hour}:${local.minute}`,
    localDate: `${local.year}-${local.month}-${local.day}`,
    regularSessionActive: isWithinHours,
  };
}
