import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-web";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import { categories, ResearchService } from "./service.js";
export { ResearchService } from "./service.js";

/** Requires ctx.web and ctx.tools. Does not replace/register host web providers or tools. */
export function registerResearchTools(ctx: Context) {
  const research = new ResearchService(ctx.web);
  const output = {
    schema: { type: "json" as const },
    render: (_args: unknown, value: unknown) => [
      { type: "text" as const, text: JSON.stringify(value) },
    ],
  };
  ctx.tools.register(
    defineTool({
      name: "scu_search",
      description:
        "定向搜索四川大学公开招聘、技术活动、升学与创新信息。多路查询合并去重，按域名分类；不查询校园个人数据，不保证年份或摘要真实性。",
      parameters: {
        category: {
          type: "string",
          enum: [...categories],
          description: "默认 general。",
        },
        query: {
          type: "string",
          required: true,
          description: "公开信息关键词，1–300 字符；勿填凭据或个人敏感信息。",
        },
        college: { type: "string", description: "学院关键词，最多80字符。" },
        year: {
          type: "integer",
          description: "1900–2200，仅作为查询词，不是日期过滤保证。",
        },
        maxQueries: {
          type: "integer",
          description: "1–4 路宿主搜索，默认4，最多并发2。",
        },
        maxResults: { type: "integer", description: "1–20 条结果，默认10。" },
      },
      output,
      execute: async (args, exec) =>
        z.json().parse(await research.search(args, exec.signal)),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "scu_read_webpage",
      description:
        "无校园凭据读取公开 HTML/text，提取 Markdown 和附件链接；不执行脚本、不解析 PDF。续读必须使用同一快照，过期后从头重读。",
      parameters: {
        url: {
          type: "string",
          required: true,
          description: "公开 HTTP(S) 地址，不接受认证参数、登录页或IP地址。",
        },
        offset: {
          type: "integer",
          description: "字符偏移，默认0；续读需 snapshotId。",
        },
        maxChars: {
          type: "integer",
          description: "单页1–20000字符，默认12000。",
        },
        refresh: {
          type: "boolean",
          description: "重新抓取，仅 offset=0 使用。",
        },
        snapshotId: {
          type: "string",
          description: "续读时原样传回上次返回值，避免拼接不同页面版本。",
        },
      },
      output,
      execute: async (args, exec) =>
        z.json().parse(await research.read(args, exec.signal)),
    }),
  );
  return research;
}
