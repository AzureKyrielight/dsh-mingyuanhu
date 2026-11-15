import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import type { CampusClient } from "./core/index.js";
import { CAMPUS_READ_ACTIONS, dispatchCampusRead } from "./domains/index.js";

export function registerDomainTools(ctx: Context, campus: CampusClient) {
  ctx.tools.register(
    defineTool({
      name: "scu_query",
      description:
        "川大校园只读查询：考表(exams)、空闲教室(classroom)、培养方案(program)、班级课表(classSchedule)、课程课表(courseSchedule)、校园卡(card)、体测(fitness)、办事申请(service)、云打印(cloudprint)、第二课堂(ccyl)、本人报修(repair)、教务通知(notices)、校历(calendar)。先用 action=catalog 获取该领域可用操作和参数说明。不执行报名、提交、绑定或缴费。",
      parameters: {
        domain: {
          type: "string",
          required: true,
          enum: Object.keys(CAMPUS_READ_ACTIONS),
        },
        action: {
          type: "string",
          required: true,
          description: "catalog 返回操作指南；其他操作按指南填写。",
        },
        input: {
          type: "json",
          description:
            "操作参数对象，不可包含密码、cookie、token或覆盖用户ID。",
        },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(args, exec) {
        if (args.action === "catalog")
          return {
            actions: [
              ...CAMPUS_READ_ACTIONS[
                args.domain as keyof typeof CAMPUS_READ_ACTIONS
              ],
            ],
            parameters: DOMAIN_GUIDES[args.domain],
          };
        if (args.domain === "cloudprint")
          return {
            supported: false,
            reason:
              "云打印使用独立 HTTP IP 端点，隔离打印会话适配尚未完成；当前不发送请求。",
          };
        const transport = {
          ...campus.transport(),
          publicRequest: async (url: string) => {
            const web = ctx.get("web");
            if (!web) throw new Error("校历需要宿主公开网页抓取服务");
            const result = await web.fetch({ url }, exec.signal);
            if (result.truncated) throw new Error("校历数据被截断");
            return {
              url: result.url,
              status: result.statusCode,
              body: result.body.content,
            };
          },
        };
        return campus.withSignal(exec.signal, async () =>
          z
            .json()
            .parse(
              await dispatchCampusRead(
                transport,
                args.domain,
                args.action,
                args.input ?? {},
              ),
            ),
        );
      },
    }),
  );
}

const DOMAIN_GUIDES: Record<string, string> = {
  exams: "list: 无参数。",
  classroom:
    "index: 无参数。types: campusNumber,buildingNumber,campusName,buildingName取自index。availability: campusNumber,date(YYYY-MM-DD)，可选buildingNumber,classroomType,classroomName,seatFrom,seatTo。",
  program:
    "colleges/grades/completion: 无参数。search: 可选college,grade。detail: fajhh取自search。",
  classSchedule:
    "options: 无参数；subjects: departmentNum；search: plan,year,department,subject,classNum,page,pageSize；schedule: planCode,classCode。编号先用options/search发现。",
  courseSchedule:
    "options: 无参数；search: semester,department,name,code,seq,category,page,pageSize；schedule: planCode,courseCode,courseSequenceCode。编号先用options/search发现。",
  card: "history: 可选sdate,edate(YYYY-MM-DD)。",
  fitness: "notices: 无参数；score: year整数必填。",
  service: "applications: status(0全部、1进行中、3完成)，page。",
  cloudprint: "status/jobs: 无参数，只读，不生成打印任务。",
  ccyl: "search: page,pageSize,name,level,scoreType,org,order,status,quality；mine/credits: page,pageSize；ordered: page,pageSize,name；orgs:无参数；library/detail:id；scoreTypes:libraryId。活动库ID和场次ID不同，不可混用。",
  repair: "mine: 无参数，查询当前账号报修工单。",
  notices: "list:page(1-20)；detail:url必须来自教务通知列表。",
  calendar: "get: 无参数。",
};
