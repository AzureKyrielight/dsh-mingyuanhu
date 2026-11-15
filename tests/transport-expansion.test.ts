import { describe, expect, it, vi } from "vitest";
import { CampusClient } from "../src/core/index.js";

describe("expanded campus transport", () => {
  it("never follows a redirect after a business write", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("", {
          status: 307,
          headers: { location: "https://service.scu.edu.cn/again" },
        }),
    );
    const campus = new CampusClient({ fetch: fetcher });
    await expect(
      campus
        .transport()
        .writeOnce("https://service.scu.edu.cn/site/process/launch", {
          method: "POST",
          headers: {},
          body: "{}",
        }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("decodes declared GBK notice bytes without corrupting Chinese", async () => {
    const campus = new CampusClient({
      fetch: async () =>
        new Response(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), {
          headers: { "content-type": "text/html; charset=gb2312" },
        }),
    });
    expect(
      (await campus.transport().request("https://jwc.scu.edu.cn/notice")).body,
    ).toBe("中文");
  });
  it("keeps the authenticated transport limited to campus domains", async () => {
    const fetcher = vi.fn();
    const campus = new CampusClient({ fetch: fetcher });
    await expect(
      campus
        .transport()
        .request("https://raw.githubusercontent.com/example/calendar"),
    ).rejects.toMatchObject({ code: "network" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
