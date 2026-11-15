// Protocol adapted from MingYuanHu (AGPL-3.0-or-later), read-only subset.
import {
  checked,
  json as parse,
  UA,
  type CampusTransport,
  type CampusResponse,
} from "./transport";
import type {
  AcademicCalendar,
  AcademicCalendarEvent,
  AcademicCalendarSemester,
} from "./types";

export function createCalendar(t: CampusTransport) {
  const MIRROR =
    "https://gh-proxy.com/https://raw.githubusercontent.com/The-Brotherhood-of-SCU/Bugaoshan/refs/heads/main/assets/academic_calendar.json";
  const REMOTE =
    "https://raw.githubusercontent.com/The-Brotherhood-of-SCU/Bugaoshan/main/assets/academic_calendar.json";

  function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  /** 把紧凑格式（eventTypes 注册表 + e 映射）展开为统一结构；已是展开格式则原样读取。 */
  function expandCalendar(value: unknown): AcademicCalendar {
    if (typeof value !== "object" || value === null)
      throw new Error("校历数据格式异常");
    const root = value as Record<string, unknown>;
    const semesters = Array.isArray(root.semesters) ? root.semesters : [];
    const types =
      typeof root.eventTypes === "object" && root.eventTypes !== null
        ? (root.eventTypes as Record<string, { l?: unknown; t?: unknown }>)
        : null;

    const result: AcademicCalendarSemester[] = [];
    for (const raw of semesters) {
      if (typeof raw !== "object" || raw === null) continue;
      const semester = raw as Record<string, unknown>;
      const events: AcademicCalendarEvent[] = [];
      if (types && typeof semester.e === "object" && semester.e !== null) {
        for (const [key, value] of Object.entries(
          semester.e as Record<string, unknown>,
        )) {
          const info = types[key];
          if (!info) continue;
          const label = text(info.l);
          if (!label) continue;
          if (typeof value === "string") {
            events.push({
              label,
              tag: text(info.t),
              date: value,
              endDate: null,
            });
          } else if (Array.isArray(value) && value.length >= 2) {
            events.push({
              label,
              tag: text(info.t),
              date: text(value[0]),
              endDate: text(value[1]) || null,
            });
          }
        }
      } else if (Array.isArray(semester.events)) {
        for (const item of semester.events) {
          if (typeof item !== "object" || item === null) continue;
          const event = item as Record<string, unknown>;
          const label = text(event.label);
          const date = text(event.date);
          if (!label || !date) continue;
          events.push({
            label,
            tag: text(event.tag),
            date,
            endDate: text(event.endDate) || null,
          });
        }
      }
      events.sort((a, b) => a.date.localeCompare(b.date));
      result.push({
        name: text(semester.n) || text(semester.name),
        startDate: text(semester.s) || text(semester.startDate),
        totalWeeks: Number(semester.w ?? semester.totalWeeks ?? 0) || 0,
        events,
      });
    }
    if (result.length === 0) throw new Error("校历中没有学期数据");
    return { semesters: result };
  }

  /** Community-maintained Bugaoshan calendar, not an official university feed. */
  async function fetchAcademicCalendar(): Promise<AcademicCalendar> {
    if (!t.publicRequest)
      throw new Error(
        "Anonymous public transport is required for the community calendar",
      );
    // Never fall back to the authenticated campus transport. Only explicit
    // upstream availability failures permit the mirror-to-origin fallback;
    // auth, cancellation, policy and unknown transport errors propagate.
    const mirror = await t.publicRequest(MIRROR, { timeoutMs: 8000 });
    if (
      mirror.status === 404 ||
      mirror.status === 408 ||
      mirror.status === 429 ||
      mirror.status >= 500
    ) {
      return expandCalendar(
        parse(await t.publicRequest(REMOTE, { timeoutMs: 8000 })),
      );
    }
    return expandCalendar(parse(mirror));
  }

  return { fetchAcademicCalendar, expandCalendar };
}
