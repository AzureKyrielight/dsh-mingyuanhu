import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { CampusClient } from "./core/index.js";
import { credentialStore, mountAccount } from "./host.js";
import { registerCampusTools } from "./tools.js";

import { registerCampusSkill } from "./skill.js";
import { registerDomainTools } from "./domain-tools.js";
import { registerResearchTools } from "./research/index.js";
import {
  researchProvidersSchema,
  registerResearchSearchProviders,
} from "./research/providers.js";
import { z } from "zod";
import { mountActions } from "./action-host.js";
import { registerActionTools } from "./action-tools.js";

export const Config = z.object({
  researchProviders: researchProvidersSchema.default({}),
}).default({ researchProviders: {} });
export const inject = ["tools", "credentials", "typert", "skills"];
export function apply(ctx: Context, config: z.infer<typeof Config>) {
  const campus = new CampusClient({ store: credentialStore(ctx) });
  mountAccount(ctx, campus);
  const actions = mountActions(ctx, campus);
  registerActionTools(ctx, actions);
  registerCampusTools(ctx, campus);
  registerCampusSkill(ctx);
  registerDomainTools(ctx, campus);
  ctx.inject(["web"], (webContext) => {
    registerResearchTools(webContext);
    registerResearchSearchProviders(webContext, config.researchProviders);
  });
}
