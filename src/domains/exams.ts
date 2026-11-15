// Protocol adapted from MingYuanHu (AGPL-3.0-or-later), read-only subset.
import {
  checked,
  json as parse,
  UA,
  type CampusTransport,
  type CampusResponse,
} from "./transport";
const assertAuthenticated = (r: CampusResponse, _service?: string) => {
  checked(r);
};
import type { ScuExam } from "./types";
const stripHtml = (v: string) => v.replace(/<[^>]+>/g, "").trim();

export function createExams(t: CampusTransport) {
  const EXAM_BLOCK_PATTERN =
    /<div class="widget-box widget-color-\w+(?: collapsed)?">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/g;
  const EXAM_TITLE_PATTERN =
    /<h5 class="widget-title smaller">\s*([\s\S]*?)\s*<\/h5>/;
  const EXAM_WEEK_PATTERN = /(\d+)周/;
  const EXAM_DATE_PATTERN = /(\d{4}-\d{2}-\d{2})\s*&nbsp;/;
  const EXAM_WEEKDAY_PATTERN = /(星期[一二三四五六日])/;
  const EXAM_TIME_PATTERN = /&nbsp;(\d{2}:\d{2}-\d{2}:\d{2})/;
  const EXAM_LOCATION_PATTERN = /地点:&nbsp;([\s\S]+?)<\/br>/;
  const EXAM_SEAT_PATTERN = /座位号:&nbsp;(\d+)/;
  const EXAM_TICKET_PATTERN = /准考证号:&nbsp;([\s\S]*?)<\/br>/;
  const EXAM_TIP_PATTERN = /考试提示信息：&nbsp;([\s\S]*?)<\/span>/;
  const EXAM_ENDED_PATTERN = /\s*（已结束）/;

  function firstGroup(pattern: RegExp, value: string): string {
    return (pattern.exec(value)?.[1] ?? "").trim();
  }

  /** 考表（教务 HTML 卡片解析）。 */
  async function fetchExams(): Promise<ScuExam[]> {
    const response = await t.academic(
      `/student/examinationManagement/examPlan/index`,
      {
        headers: { Accept: "text/html,*/*" },
      },
    );
    assertAuthenticated(response, "考表");
    const exams: ScuExam[] = [];
    for (const block of response.body.matchAll(EXAM_BLOCK_PATTERN)) {
      const body = block[1] ?? "";
      const name = stripHtml(firstGroup(EXAM_TITLE_PATTERN, body)).replace(
        EXAM_ENDED_PATTERN,
        "",
      );
      const week = firstGroup(EXAM_WEEK_PATTERN, body);
      exams.push({
        courseName: name || "未知",
        week: week ? `第 ${week} 周` : "未知",
        date: firstGroup(EXAM_DATE_PATTERN, body) || "未知",
        weekday: firstGroup(EXAM_WEEKDAY_PATTERN, body) || "未知",
        timeRange: firstGroup(EXAM_TIME_PATTERN, body) || "未知",
        location:
          firstGroup(EXAM_LOCATION_PATTERN, body).replaceAll("&nbsp;", " ") ||
          "未知",
        seatNumber: firstGroup(EXAM_SEAT_PATTERN, body) || "未知",
        ticketNumber: firstGroup(EXAM_TICKET_PATTERN, body),
        tip: firstGroup(EXAM_TIP_PATTERN, body) || "无",
      });
    }
    return exams;
  }

  return { fetchExams };
}
