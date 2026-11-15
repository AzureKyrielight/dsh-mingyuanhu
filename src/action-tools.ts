import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ActionController } from "./action-host.js";

/** Preparation is never a grant of permission and never calls commit. */
export function registerActionTools(ctx: Context, actions: ActionController) {
  ctx.tools.register(
    defineTool({
      name: "scu_action_prepare",
      description:
        "仅创建冻结校园操作草稿，不提交。返回ID后请用户在明远湖光面板查看全部payload并二次确认。支持二课报名/取消/订阅和报修撤回（activeId不是行id）。不支持报修发布、办事大厅提交、上传或浏览器操作。用户按钮仅授权该业务操作，不替代宿主工具approval policy。结果unknown时先人工核对，禁止自动重建草稿重试。",
      parameters: {
        kind: {
          type: "string",
          required: true,
          enum: [
            "ccyl.signup",
            "ccyl.cancel-signup",
            "ccyl.subscribe",
            "ccyl.cancel-subscribe",
            "repair.withdraw",
          ],
        },
        activityId: { type: "string" },
        scoreType: { type: "string" },
        libraryId: { type: "string" },
        activeId: { type: "string" },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      execute: async (args, exec) => ({
        ...(await actions.prepare(args, exec.signal)),
      }),
    }),
  );
}
