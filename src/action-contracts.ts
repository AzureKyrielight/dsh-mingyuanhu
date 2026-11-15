import { z } from "zod";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol/remote-info";
import type {
  RemoteResult,
  TypertRemoteCodecSpec,
  TypertRemoteMethodSpec,
} from "@deepseek-ai/dsh-typert-protocol";
import type { CampusAction } from "./actions/actions.js";
import type { CommitResult, DraftStatus } from "./actions/draft-store.js";

export interface ActionPreview {
  id: string;
  action: CampusAction;
  createdAt: number;
  expiresAt: number;
  status: DraftStatus;
}
export interface PreparedAction {
  id: string;
  summary: string;
  expiresAt: number;
}
export type ActionReply<T> =
  { success: true; data: T } | { success: false; code: "unavailable" };
export interface ActionRemote {
  inspect(id: string): Promise<RemoteResult<ActionReply<ActionPreview>>>;
  commit(id: string): Promise<RemoteResult<ActionReply<CommitResult>>>;
}
export const draftIdSchema = z.string().uuid();
const previewSchema = z.object({
  id: draftIdSchema,
  action: z.object({ kind: z.string(), payload: z.json() }),
  createdAt: z.number(),
  expiresAt: z.number(),
  status: z.enum([
    "prepared",
    "submitting",
    "succeeded",
    "rejected",
    "unknown",
  ]),
});
const commitSchema = z.object({
  status: z.enum(["succeeded", "rejected", "unknown"]),
  message: z.string().optional(),
});
function codec(schema: z.ZodType, name: string): TypertRemoteCodecSpec {
  return {
    mode: "strict",
    typeSymbol: `dsh-mingyuanhu#${name}`,
    create: () => schema,
  };
}
const methods: Record<`scuActions/${string}`, TypertRemoteMethodSpec> = {};
for (const name of ["inspect", "commit"] as const) {
  const input = codec(draftIdSchema, "ActionDraftId");
  const reply = z.discriminatedUnion("success", [
    z.object({
      success: z.literal(true),
      data: name === "inspect" ? previewSchema : commitSchema,
    }),
    z.object({ success: z.literal(false), code: z.literal("unavailable") }),
  ]);
  methods[`scuActions/${name}`] = {
    service: "scuActions",
    invocation: { kind: "direct" },
    parameters: [
      { name: "id", source: "json", codec: input, strictCodec: input },
    ],
    result: {
      ...codec(reply, `Action${name}Reply`),
      encode: (value) => reply.parse(value),
      decode: (value) => reply.parse(value),
    },
  };
}
export const ACTION_REMOTE = createTypertRemoteInfo(
  { package: "dsh-mingyuanhu-actions", methods },
  z,
);

/** Strict prepare input deliberately has no binding, userId, payload or approval flag. */
const id = z.string().trim().min(1).max(256);
export const prepareActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ccyl.signup"),
    activityId: id,
    scoreType: id,
  }),
  z.strictObject({ kind: z.literal("ccyl.cancel-signup"), activityId: id }),
  z.strictObject({ kind: z.literal("ccyl.subscribe"), libraryId: id }),
  z.strictObject({ kind: z.literal("ccyl.cancel-subscribe"), libraryId: id }),
  z.strictObject({ kind: z.literal("repair.withdraw"), activeId: id }),
]);
export type PrepareActionInput = z.infer<typeof prepareActionSchema>;
