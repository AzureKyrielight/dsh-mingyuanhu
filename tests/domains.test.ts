import { describe, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv } from "node:crypto";
import {
  dispatchCampusRead as read,
  CAMPUS_READ_ACTIONS,
} from "../src/domains";
import type {
  CampusTransport,
  CampusRequestInit,
} from "../src/domains/transport";
function fixture(bodies: (string | object)[]) {
  const calls: { url: string; init?: CampusRequestInit }[] = [];
  const request = vi.fn(async (url: string, init?: CampusRequestInit) => {
    calls.push({ url, init });
    const value = bodies.shift();
    if (value === undefined) throw new Error("Unexpected request " + url);
    return {
      url,
      status: 200,
      body: typeof value === "string" ? value : JSON.stringify(value),
    };
  });
  const t: CampusTransport = {
    request,
    publicRequest: request,
    academic: request,
    bindIdentity: vi.fn(async () => {}),
    authorizationHeaders: vi.fn(async () => ({
      Authorization: "Bearer fixture-secret",
    })),
    bootstrap: vi.fn(async (url) => ({ url, status: 200, body: "" })),
  };
  return { t, calls };
}
describe("verified campus read protocol fixtures", () => {
  it("community calendar requires anonymous transport and never calls campus auth", async () => {
    const { t } = fixture([]);
    delete t.publicRequest;
    await expect(read(t, "calendar", "get")).rejects.toThrow(
      "Anonymous public transport",
    );
    expect(t.request).not.toHaveBeenCalled();
    expect(t.bindIdentity).not.toHaveBeenCalled();
    expect(t.authorizationHeaders).not.toHaveBeenCalled();
  });
  it("calendar falls back only for public availability failures", async () => {
    const { t } = fixture([]);
    t.publicRequest = vi
      .fn()
      .mockResolvedValueOnce({
        url: "https://gh-proxy.com/",
        status: 503,
        body: "",
      })
      .mockResolvedValueOnce({
        url: "https://raw.githubusercontent.com/",
        status: 200,
        body: JSON.stringify({ semesters: [{ name: "Fall", events: [] }] }),
      });
    expect(await read(t, "calendar", "get")).toMatchObject({
      semesters: [{ name: "Fall" }],
    });
    expect(t.publicRequest).toHaveBeenCalledTimes(2);
    expect(t.request).not.toHaveBeenCalled();
    for (const call of vi.mocked(t.publicRequest).mock.calls)
      expect(call[1]).toEqual({ timeoutMs: 8000 });
  });
  it("calendar propagates authentication and policy failures without fallback", async () => {
    const { t } = fixture([]);
    t.publicRequest = vi.fn().mockResolvedValue({
      url: "https://gh-proxy.com/",
      status: 401,
      body: "",
    });
    await expect(read(t, "calendar", "get")).rejects.toThrow("401");
    expect(t.publicRequest).toHaveBeenCalledTimes(1);
    t.publicRequest = vi.fn().mockRejectedValue(new Error("policy denied"));
    await expect(read(t, "calendar", "get")).rejects.toThrow("policy denied");
    expect(t.publicRequest).toHaveBeenCalledTimes(1);
    expect(t.request).not.toHaveBeenCalled();
  });
  it("uses actual classroom form names and academic session transport", async () => {
    const { t, calls } = fixture([{ rows: [] }]);
    await read(t, "classroom", "availability", {
      campusNumber: "01",
      buildingNumber: "02",
      date: "2026-11-15",
    });
    expect(calls[0].url).toBe(
      "/student/teachingResources/classroomUseStatus/jasInfo",
    );
    expect(
      Object.fromEntries(new URLSearchParams(calls[0].init?.body)),
    ).toEqual({
      xqh: "01",
      jxlh: "02",
      jslx: "",
      jasm: "",
      zwFrom: "",
      zwTo: "",
      searchDate: "2026-11-15",
    });
  });
  it("extracts hidden campus arrays and select options", async () => {
    const { t } = fixture([
      `<input id="xqList" value='[{"id":"01"}]'><input id="jxlList" value='[]'>`,
      `<select name="xsh"><option value="">all</option><option value="03">Math</option></select>`,
    ]);
    expect(await read(t, "classroom", "index")).toEqual({
      campuses: [{ id: "01" }],
      buildings: [],
    });
    expect(await read(t, "program", "colleges")).toEqual([
      { value: "03", label: "Math" },
    ]);
  });
  it("loads program detail and direct plan completion without evaluating script", async () => {
    const { t, calls } = fixture([
      { data: { courses: [] } },
      `var zNodes = [{"id":1}]; data: ['Plan']`,
    ]);
    await read(t, "program", "detail", { fajhh: "abc" });
    expect(calls[0].init?.body).toBe("fajhh=abc&lx=1");
    expect(await read(t, "program", "completion")).toEqual([
      { id: "", name: "Plan", nodes: [{ id: 1 }] },
    ]);
  });
  it("maps class/course pagination and callback query parameters", async () => {
    const { t, calls } = fixture([
      [{ records: [{ classCode: "c" }], pageContext: { totalCount: 1 } }],
      [[{ courseName: "Math" }]],
    ]);
    expect(
      await read(t, "classSchedule", "search", { plan: "p", page: 2 }),
    ).toEqual({ records: [{ classCode: "c" }], total: 1 });
    expect(
      new URLSearchParams(calls[0].init?.body).get("executiveEducationPlanNum"),
    ).toBe("p");
    expect(
      await read(t, "courseSchedule", "schedule", {
        planCode: "p",
        courseCode: "c&x",
        courseSequenceCode: "1",
      }),
    ).toEqual([{ courseName: "Math" }]);
    expect(calls[1].url).toContain("courseCode=c%26x&courseSequenceCode=1");
  });
  it("parses exam HTML cards", async () => {
    const { t } = fixture([
      `<div class="widget-box widget-color-blue"><h5 class="widget-title smaller">Math（已结束）</h5>第10周 2026-11-15&nbsp;星期日&nbsp;09:00-11:00 地点:&nbsp;A101</br>座位号:&nbsp;12</div></div></div></div>`,
    ]);
    expect(await read(t, "exams", "list")).toMatchObject([
      { courseName: "Math", date: "2026-11-15", seatNumber: "12" },
    ]);
  });
  it("binds WFW and computes card spending and balance", async () => {
    const { t, calls } = fixture([
      { e: 0, d: {} },
      {
        e: "0",
        d: {
          list: {
            "2026-01-01": [
              {
                toname: "canteen",
                jdate: 100,
                xfje: "5",
                syje: 20,
                type: "消费",
                time: "12:00",
              },
            ],
          },
        },
      },
    ]);
    expect(
      await read(t, "card", "history", { sdate: "2026-01-01" }),
    ).toMatchObject({ totalCost: 5, txnCount: 1, balance: 20 });
    expect(t.bindIdentity).toHaveBeenCalledOnce();
    expect(calls[1].url).toBe(
      "https://wfw.scu.edu.cn/cardhis/wap/default/get-index",
    );
    expect(calls[1].init?.body).toBe("sdate=2026-01-01&edate=");
  });
  it("uses fitness SSO and year_num, not guessed REST routes", async () => {
    const { t, calls } = fixture([{ status: 1, data: { score: 90 } }]);
    expect(await read(t, "fitness", "score", { year: 2026 })).toEqual({
      score: 90,
    });
    expect(t.bootstrap).toHaveBeenCalledWith(
      "https://pead.scu.edu.cn/bdlp_h5_fitness_test/public/index.php/index/login/scuMsLogin",
    );
    expect(calls[0].init?.body).toBe("year_num=2026");
  });
  it("loads own service applications with verified filter defaults", async () => {
    const { t, calls } = fixture([{ e: 0, d: { list: [{ id: 1 }] } }]);
    expect(
      await read(t, "service", "applications", { page: 2, status: 1 }),
    ).toEqual([{ id: 1 }]);
    expect(new URL(calls[0].url).pathname).toBe("/site/process/inst-list");
    expect(new URL(calls[0].url).searchParams.get("page_size")).toBe("20");
  });
  it("cloudprint returns whitelist jobs, never SessionId or server paths", async () => {
    const { t } = fixture([
      { code: 0, SessionId: "secret" },
      {
        code: 0,
        result: [
          {
            dwJobId: 1,
            szJobName: "notes.pdf",
            szPath: "private",
            szPaperDetail: '{"pages":2}',
          },
        ],
      },
    ]);
    expect(await read(t, "cloudprint", "jobs")).toEqual([
      { dwJobId: 1, szJobName: "notes.pdf", szPaperDetail: { pages: 2 } },
    ]);
  });
  it("cloudprint rejects untrusted SSO origins", async () => {
    const { t, calls } = fixture([
      { code: 0 },
      { code: 0, result: "https://evil.invalid/login" },
    ]);
    await expect(read(t, "cloudprint", "status")).rejects.toThrow("不受信任");
    expect(calls).toHaveLength(2);
  });
  it("performs second classroom code exchange with private token only in headers", async () => {
    const { t, calls } = fixture([
      `<script>window.location='https://dekt.scu.edu.cn/?code=fixture-code'</script>`,
      { code: 0, token: "ccyl-private", user: { id: "u" } },
      { code: 0, list: [{ id: 1, token: "should-not-leak" }] },
    ]);
    expect(await read(t, "ccyl", "credits")).toEqual([{ id: 1 }]);
    expect(new URL(calls[0].url).searchParams.get("application_key")).toBe(
      "scdxplugin_cas_apereo17",
    );
    expect(calls[1].init?.body).toBe('{"code":"fixture-code"}');
    expect(calls[2].url).toBe(
      "https://dekt.scu.edu.cn/ccyl-api/app/credit/list",
    );
    expect(calls[2].init?.headers?.token).toBe("ccyl-private");
  });
  it("decrypts repair and derives only own user ID from common addresses", async () => {
    const encrypt = (v: unknown) => {
      const c = createCipheriv(
        "aes-128-cbc",
        "1974051005060708",
        "1974051005060708",
      );
      return Buffer.concat([c.update(JSON.stringify(v)), c.final()]).toString(
        "base64",
      );
    };
    const { t, calls } = fixture([
      encrypt({ status: "success", data: "fixture-token-key-123" }),
      encrypt({ status: "success", data: [{ createUser: "own-user" }] }),
      encrypt({
        status: "success",
        data: {
          rows: [{ id: "wrong", activeId: "ticket-1", contentText: "light" }],
        },
      }),
    ]);
    const req = t.request;
    t.request = async (url, init) =>
      url.includes("scdxplugin_jwt31")
        ? {
            url: "https://zhhq.scu.edu.cn/account/login?userinfo=fixture",
            status: 200,
            body: "",
          }
        : req(url, init);
    expect(await read(t, "repair", "mine")).toMatchObject([
      { id: "ticket-1", content: "light" },
    ]);
    const form = new URLSearchParams(calls[2].init?.body);
    expect(JSON.parse(form.get("search")!)[0].searchValue).toBe("own-user");
    const d = createDecipheriv(
      "aes-128-cbc",
      "bf8ec0449942e7f4",
      "web201911chengdu",
    );
    const signed = JSON.parse(
      Buffer.concat([
        d.update(Buffer.from(calls[2].init!.headers!.Token, "base64")),
        d.final(),
      ]).toString(),
    );
    expect(signed.tokenKey).toBe("fixture-token-key-123");
    expect(signed.GUID).toMatch(/^[a-f0-9-]{36}$/);
  });
  it("parses public notices and compact calendar without network or disk writes", async () => {
    const { t } = fixture([
      `<li><a href="../info/1/2.htm"><div class="date"><p>11/15</p><span>2026</span></div><div class="text"><p>Notice &amp; exam</p>`,
      {
        eventTypes: { start: { l: "Start", t: "term" } },
        semesters: [
          { n: "Fall", s: "2026-09-01", w: 20, e: { start: "2026-09-01" } },
        ],
      },
    ]);
    expect(await read(t, "notices", "list")).toMatchObject([
      { id: "info/1/2.htm", title: "Notice & exam" },
    ]);
    expect(await read(t, "calendar", "get")).toMatchObject({
      semesters: [{ name: "Fall", events: [{ label: "Start" }] }],
    });
  });
  it("rejects all write actions and identity overrides before network", async () => {
    const { t, calls } = fixture([]);
    for (const domain of Object.keys(CAMPUS_READ_ACTIONS))
      await expect(read(t, domain, "submit", {})).rejects.toThrow(
        "Unsupported",
      );
    await expect(
      read(t, "repair", "mine", { userId: "another" }),
    ).rejects.toThrow("overrides");
    await expect(
      read(t, "program", "courseDetail", { url: "https://evil.invalid" }),
    ).rejects.toThrow("Unsupported");
    expect(calls).toHaveLength(0);
  });
  it("rejects expired envelopes and malformed login HTML", async () => {
    const { t } = fixture([{ status: 0, info: "请重新登录" }]);
    await expect(read(t, "fitness", "score", { year: 2026 })).rejects.toThrow(
      "登录",
    );
    const other = fixture(['<input type="password">']);
    await expect(read(other.t, "exams", "list")).rejects.toThrow("expired");
  });
});
