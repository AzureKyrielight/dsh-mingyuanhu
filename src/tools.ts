import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import type { CampusClient } from "./core/index.js";

export function registerCampusTools(ctx: Context, campus: CampusClient) {
  const output = {
    schema: { type: "json" as const },
    render: (_args: unknown, value: unknown) => [
      { type: "text" as const, text: JSON.stringify(value) },
    ],
  };
  const query = (signal: AbortSignal, operation: () => Promise<unknown>) =>
    campus.withSignal(signal, async () => z.json().parse(await operation()));
  ctx.tools.register(
    defineTool({
      name: "scu_status",
      description:
        "查询川大校园账号的脱敏登录状态。未登录时请用户在设置中的明远湖光面板登录。",
      parameters: {},
      output,
      execute: (_args, exec) => query(exec.signal, () => campus.status()),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "scu_semesters",
      description: "查询本人可用的教务学期和课表 planCode。",
      parameters: {},
      output,
      execute: (_args, exec) => query(exec.signal, () => campus.semesters()),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "scu_grades",
      description: "只读查询本人成绩或培养方案成绩。",
      parameters: {
        scheme: {
          type: "boolean",
          description: "true 查询培养方案成绩；默认查询成绩。",
        },
      },
      output,
      execute: (args, exec) => query(exec.signal, () => campus.grades(args)),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "scu_schedule",
      description: "只读查询本人指定学期课表。",
      parameters: {
        planCode: {
          type: "string",
          required: true,
          description: "scu_semesters 返回的 planCode。",
        },
      },
      output,
      execute: (args, exec) => query(exec.signal, () => campus.schedule(args)),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "scu_balance",
      description:
        "只读查询本人已绑定房间的电费余额，或发现校区、楼栋和单元。不绑定房间、不缴费，不能查询他人房间。",
      parameters: {
        action: {
          type: "string",
          enum: ["balance", "campus", "buildings", "units"],
          required: true,
        },
        type: {
          type: "integer",
          enum: [1, 2],
          description: "余额接口类型：1 或 2。action=balance 时必填。",
        },
        schoolCode: {
          type: "string",
          description: "buildings/units 使用校区代码。",
        },
        regCode: { type: "string", description: "units 使用楼栋代码。" },
      },
      output,
      execute: (args, exec) =>
        query(exec.signal, () => {
          if (args.action === "campus") return campus.balanceCampus();
          if (!args.schoolCode && args.action !== "balance")
            throw new Error("需要 schoolCode");
          if (args.action === "buildings")
            return campus.balanceBuildings({ schoolCode: args.schoolCode! });
          if (args.action === "units") {
            if (!args.regCode) throw new Error("需要 regCode");
            return campus.balanceUnits({
              schoolCode: args.schoolCode!,
              regCode: args.regCode,
            });
          }
          if (args.type !== 1 && args.type !== 2)
            throw new Error("需要 type: 1 或 2");
          return campus.balance({ type: args.type });
        }),
    }),
  );
}
