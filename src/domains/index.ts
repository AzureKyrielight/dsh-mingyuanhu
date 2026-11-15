import { createAcademic } from "./academic";
import { createExams } from "./exams";
import { createCard } from "./card";
import { createFitness } from "./fitness";
import { createService } from "./service";
import { createCloudprint } from "./cloudprint";
import { createCcyl } from "./ccyl";
import { createRepair } from "./repair";
import { createNotices } from "./notices";
import { createCalendar } from "./calendar";
import {
  integer,
  record,
  redactSecrets,
  type CampusTransport,
} from "./transport";
export type {
  CampusTransport,
  CampusRequestInit,
  CampusResponse,
} from "./transport";

/** Explicit allowlist: no arbitrary URL, user ID, write action or credential input. */
export const CAMPUS_READ_ACTIONS = {
  exams: ["list"],
  classroom: ["index", "types", "availability"],
  program: ["colleges", "grades", "search", "detail", "completion"],
  classSchedule: ["options", "subjects", "search", "schedule"],
  courseSchedule: ["options", "search", "schedule"],
  card: ["history"],
  fitness: ["notices", "score"],
  service: ["applications"],
  cloudprint: ["status", "jobs"],
  ccyl: [
    "search",
    "mine",
    "ordered",
    "library",
    "detail",
    "scoreTypes",
    "credits",
    "orgs",
  ],
  repair: ["mine"],
  notices: ["list", "detail"],
  calendar: ["get"],
} as const;

export async function dispatchCampusRead(
  t: CampusTransport,
  domain: string,
  action: string,
  input: unknown = {},
): Promise<unknown> {
  if (
    !Object.hasOwn(CAMPUS_READ_ACTIONS, domain) ||
    !(
      CAMPUS_READ_ACTIONS[
        domain as keyof typeof CAMPUS_READ_ACTIONS
      ] as readonly string[]
    ).includes(action)
  )
    throw new Error("Unsupported campus read action");
  if (!record(input)) throw new Error("Input must be an object");
  if (
    Object.keys(input).some((k) =>
      /token|password|authorization|cookie|userId/i.test(k),
    )
  )
    throw new Error("Credential and identity overrides are not permitted");
  const s = (key: string, required = false): string => {
    const v = input[key];
    if (v === undefined && !required) return "";
    if (typeof v !== "string" || v.length > 1000 || (required && !v.trim()))
      throw new Error(`Invalid ${key}`);
    return v;
  };
  const p = () => integer(input.page, 1, 10000);
  const ps = (fallback = 100) => integer(input.pageSize, fallback, 100);
  const a = createAcademic(t);
  const run = async (): Promise<unknown> => {
    switch (domain) {
      case "exams":
        return createExams(t).fetchExams();
      case "classroom":
        if (action === "index") return a.fetchClassroomIndex();
        if (action === "types")
          return a.fetchClassroomTypes({
            campusNumber: s("campusNumber", true),
            buildingNumber: s("buildingNumber", true),
            campusName: s("campusName", true),
            buildingName: s("buildingName", true),
          });
        return a.fetchClassroomAvailability({
          campusNumber: s("campusNumber", true),
          buildingNumber: s("buildingNumber"),
          classroomType: s("classroomType"),
          classroomName: s("classroomName"),
          seatFrom: s("seatFrom"),
          seatTo: s("seatTo"),
          date: s("date", true),
        });
      case "program":
        if (action === "colleges") return a.fetchProgramColleges();
        if (action === "grades") return a.fetchProgramGrades();
        if (action === "search")
          return a.searchPrograms({ college: s("college"), grade: s("grade") });
        if (action === "detail") return a.fetchProgramDetail(s("fajhh", true));
        return a.fetchPlanCompletion();
      case "classSchedule":
        if (action === "options") return a.fetchClassScheduleOptions();
        if (action === "subjects")
          return a.fetchClassSubjects(s("departmentNum", true));
        if (action === "schedule")
          return a.fetchClassSchedule(
            s("planCode", true),
            s("classCode", true),
          );
        return a.searchClasses({
          plan: s("plan"),
          year: s("year"),
          department: s("department"),
          subject: s("subject"),
          classNum: s("classNum"),
          page: p(),
          pageSize: ps(),
        });
      case "courseSchedule":
        if (action === "options") return a.fetchCourseCurriculumOptions();
        if (action === "schedule")
          return a.fetchCourseSchedule(
            s("planCode", true),
            s("courseCode", true),
            s("courseSequenceCode", true),
          );
        return a.searchCourses({
          semester: s("semester"),
          department: s("department"),
          name: s("name"),
          code: s("code"),
          seq: s("seq"),
          category: s("category"),
          page: p(),
          pageSize: ps(),
        });
      case "card":
        return createCard(t).fetchCardHistory(s("sdate"), s("edate"));
      case "fitness": {
        if (action === "notices") return createFitness(t).fetchFitnessNotices();
        if (input.year === undefined) throw new Error("year is required");
        return createFitness(t).fetchFitnessScore(integer(input.year, 1, 9999));
      }
      case "service": {
        const status = input.status ?? 0;
        if (
          typeof status !== "number" ||
          !Number.isInteger(status) ||
          status < 0 ||
          status > 100
        )
          throw new Error("Invalid status");
        return createService(t).fetchMyApplications(status, p());
      }
      case "cloudprint":
        return action === "status"
          ? createCloudprint(t).fetchCloudPrintStatus()
          : createCloudprint(t).fetchCloudPrintJobs();
      case "repair":
        return createRepair(t).fetchMyRepairTickets();
      case "notices":
        return action === "list"
          ? createNotices(t).fetchJwcNotices(integer(input.page, 1, 20))
          : createNotices(t).fetchJwcNotice(s("url", true));
      case "calendar":
        return createCalendar(t).fetchAcademicCalendar();
      case "ccyl": {
        const c = createCcyl(t);
        if (action === "mine") return c.myCcylActivities(p(), ps(20));
        if (action === "ordered")
          return c.orderedCcylActivities(p(), ps(20), s("name"));
        if (action === "credits") return c.ccylCredits(p(), ps(50));
        if (action === "orgs") return c.ccylOrgs();
        if (action === "library") return c.ccylActivityLibrary(s("id", true));
        if (action === "detail") return c.ccylActivityDetail(s("id", true));
        if (action === "scoreTypes")
          return c.ccylActivityScoreTypes(s("libraryId", true));
        return c.searchCcylActivities({
          page: p(),
          pageSize: ps(20),
          name: s("name"),
          level: s("level"),
          scoreType: s("scoreType"),
          org: s("org"),
          order: s("order"),
          status: s("status"),
          quality: s("quality"),
        });
      }
    }
  };
  return redactSecrets(await run());
}
