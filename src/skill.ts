import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-skill";

export function registerCampusSkill(ctx: Context) {
  ctx.skills.register({
    name: "scu-campus",
    source: "bundled",
    description:
      "查询四川大学本人成绩、培养方案成绩、学期、课表与已绑定房间电费余额时使用。",
    content: `# 四川大学校园查询

先调用 scu_status 检查登录状态。未登录时请用户在 DSH 设置 → 明远湖光 面板中登录。不要让用户在聊天、工具参数、命令、文件或环境变量中提供密码、验证码或登录票据；不要代为执行登录。

- scu_semesters：获取可用学期；课表查询使用返回的 planCode。
- scu_grades：查询本人成绩；scheme=true 查询培养方案成绩。
- scu_schedule：根据 planCode 查询本人课表。
- scu_balance：action=balance 且 type=1 或 2 查询本人已绑定房间；campus/buildings/units 只发现校区、楼栋、单元，不绑定房间或缴费。不要请求他人房间。

只报告接口实际返回的数据。认证失效或验证码错误时转回账号面板，不循环尝试密码。`,
  });
}
