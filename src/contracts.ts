import { z } from "zod";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol/remote-info";
import type {
  RemoteResult,
  TypertRemoteCodecSpec,
  TypertRemoteMethodSpec,
} from "@deepseek-ai/dsh-typert-protocol";

export const signInSchema = z.strictObject({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
  captcha: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("auto") }),
    z.strictObject({
      mode: z.literal("manual"),
      challengeId: z.string().min(1).max(256),
      text: z.string().min(1).max(32),
    }),
  ]),
  rememberSession: z.boolean(),
});
export type SignInInput = z.infer<typeof signInSchema>;
export interface AccountStatus {
  connected: boolean;
  principal: string | null;
  expiresAt: string | null;
}
export interface Challenge {
  challengeId: string;
  image: string;
}
export type AccountReply<T> =
  { success: true; data: T } | { success: false; code: string };
export interface AccountRemote {
  status(): Promise<RemoteResult<AccountReply<AccountStatus>>>;
  challenge(): Promise<RemoteResult<AccountReply<Challenge>>>;
  signIn(
    input: SignInInput,
  ): Promise<RemoteResult<AccountReply<AccountStatus>>>;
  signOut(): Promise<RemoteResult<AccountReply<null>>>;
}

function codec(schema: z.ZodType, name: string): TypertRemoteCodecSpec {
  return {
    mode: "strict",
    typeSymbol: `dsh-mingyuanhu#${name}`,
    create: () => schema,
  };
}
const statusSchema = z.object({
  connected: z.boolean(),
  principal: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
const challengeSchema = z.object({
  challengeId: z.string(),
  image: z.string(),
});
const methods: Record<`scuAccount/${string}`, TypertRemoteMethodSpec> = {};
for (const name of ["status", "challenge", "signIn", "signOut"] as const) {
  const input = codec(signInSchema, "SignInInput");
  const reply = z.discriminatedUnion("success", [
    z.object({
      success: z.literal(true),
      data:
        name === "challenge"
          ? challengeSchema
          : name === "signOut"
            ? z.null()
            : statusSchema,
    }),
    z.object({ success: z.literal(false), code: z.string() }),
  ]);
  const result = {
    ...codec(reply, `${name}Reply`),
    encode: (value: unknown) => reply.parse(value),
    decode: (value: unknown) => reply.parse(value),
  };
  methods[`scuAccount/${name}`] = {
    service: "scuAccount",
    invocation: { kind: "direct" },
    result,
    parameters:
      name === "signIn"
        ? [{ name: "input", source: "json", codec: input, strictCodec: input }]
        : [],
  };
}
export const ACCOUNT_REMOTE = createTypertRemoteInfo(
  { package: "dsh-mingyuanhu", methods },
  z,
);
