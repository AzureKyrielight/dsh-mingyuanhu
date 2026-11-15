import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { CampusClient } from "./core/index.js";
import { credentialStore, mountAccount } from "./host.js";
import { registerCampusTools } from "./tools.js";

import { registerCampusSkill } from "./skill.js";

export const inject = ["tools", "credentials", "typert", "skills"];
export function apply(ctx: Context) {
  const campus = new CampusClient({ store: credentialStore(ctx) });
  mountAccount(ctx, campus);
  registerCampusTools(ctx, campus);
  registerCampusSkill(ctx);
}
