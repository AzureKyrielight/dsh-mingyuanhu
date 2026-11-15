import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActionPanel, ActionPreviewView, actionZh } from "../src/action-ui.js";
import type { ActionRemote } from "../src/action-contracts.js";
const t = (key: keyof typeof actionZh) => actionZh[key];
describe("action UI real React SSR", () => {
  it("renders input review stage without premature commit controls or network calls", () => {
    const remote = {
      inspect: vi.fn(),
      commit: vi.fn(),
    } as unknown as ActionRemote;
    const html = renderToStaticMarkup(
      createElement(ActionPanel, { remote, t }),
    );
    expect(html).toContain("草稿 ID");
    expect(html).toContain("查看冻结草稿");
    expect(html).not.toContain("最终确认并提交一次");
    expect(html).toContain("报修发布、办事大厅提交、上传、浏览器操作不可用");
    expect(remote.inspect).not.toHaveBeenCalled();
    expect(remote.commit).not.toHaveBeenCalled();
  });
  it("renders every frozen field as escaped text, never active HTML", () => {
    const html = renderToStaticMarkup(
      createElement(ActionPreviewView, {
        t,
        preview: {
          id: "00000000-0000-4000-8000-000000000000",
          createdAt: 0,
          expiresAt: 60000,
          status: "prepared",
          action: {
            kind: "ccyl.signup",
            payload: {
              activityId: "<script>alert(1)</script>",
              scoreType: "score&all",
            },
          },
        },
      }),
    );
    expect(html).toContain("activityId");
    expect(html).toContain("scoreType");
    expect(html).toContain("score&amp;all");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("1970-01-01T00:01:00.000Z");
  });
});
