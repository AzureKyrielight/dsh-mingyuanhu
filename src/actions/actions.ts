import { frozenJson } from "./draft-store";

export interface RepairSubmitPayload {
  type: "0";
  ifShielding: "1";
  areaName: string;
  address: string;
  projectName: string;
  bookDate: string;
  bookTime: string;
  repairUserName: string;
  repairUserMobile: string;
  repairDeptName: "";
  ifOnduty: "0" | "1";
  repairNum: 1;
  content: string;
  ifPublish: "1";
  ifUrgent: "0";
  id: "";
  resourcesVOS: readonly [];
  source: "1";
  projectId: string;
  areaId: string;
  ifRecord: 0;
  payName?: string;
  acceptDeptId?: string;
  acceptDeptName?: string;
}
export type CampusAction =
  | { kind: "repair.submit"; payload: RepairSubmitPayload }
  | { kind: "repair.withdraw"; payload: { id: string } }
  | { kind: "ccyl.signup"; payload: { activityId: string; scoreType: string } }
  | {
      kind: "ccyl.cancel-signup";
      payload: { activityId: string; userId: string };
    }
  | {
      kind: "ccyl.subscribe" | "ccyl.cancel-subscribe";
      payload: { libraryId: string };
    }
  | {
      kind: "service.submit";
      payload: {
        appId: string;
        starterDepartId: string;
        formData: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      };
    };

function required(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Missing ${label}`);
  return value;
}
export interface RepairPreparationContext {
  /** Resolve from this bound account's common-address lookup, NOT from agent parameters. */
  address: {
    id: string;
    areaId: string;
    areaName: string;
    addressDetail: string;
    phone: string;
  };
  /** Resolve leaf value and full category/project label from getProjectByAreaId. */
  project: { value: string; label: string };
  department?: { deptId: string; deptName: string; payName: string };
}
export function prepareRepairSubmit(
  input: {
    content: string;
    bookDate?: string;
    bookTime?: string;
    realname?: string;
    allowAbsent?: boolean;
    images?: readonly string[];
  },
  context: RepairPreparationContext,
): CampusAction {
  if (input.images?.length)
    throw new Error(
      "Image uploads are unavailable: owner-selected attachment capability required",
    );
  if (input.bookTime && !input.bookDate)
    throw new Error("Book time requires book date");
  const { address, project, department } = context;
  required(address.id, "address");
  required(address.areaId, "area");
  required(project.value, "project leaf");
  return frozenJson({
    kind: "repair.submit",
    payload: {
      type: "0",
      ifShielding: "1",
      areaName: address.areaName,
      address: address.addressDetail,
      projectName: required(project.label, "full project label"),
      bookDate: input.bookDate ?? "",
      bookTime: input.bookTime ?? "",
      repairUserName: input.realname ?? "",
      repairUserMobile: address.phone,
      repairDeptName: "",
      ifOnduty: input.allowAbsent ? "1" : "0",
      repairNum: 1,
      content: required(input.content, "description").trim(),
      ifPublish: "1",
      ifUrgent: "0",
      id: "",
      resourcesVOS: [],
      source: "1",
      projectId: project.value,
      areaId: address.areaId,
      ifRecord: 0,
      ...(department
        ? {
            payName: department.payName,
            acceptDeptId: department.deptId,
            acceptDeptName: department.deptName,
          }
        : {}),
    },
  });
}
export function prepareRepairWithdraw(activeId: string): CampusAction {
  return frozenJson({
    kind: "repair.withdraw",
    payload: { id: required(activeId, "activeId (not list row id)") },
  });
}
export function prepareCcylSignup(
  activityId: string,
  scoreType: string,
): CampusAction {
  return frozenJson({
    kind: "ccyl.signup",
    payload: {
      activityId: required(activityId, "activityId"),
      scoreType: required(scoreType, "scoreType"),
    },
  });
}
/** userId MUST be obtained by Host from bound CCYL login response, never from agent input. */
export function prepareCcylCancelSignup(
  activityId: string,
  authenticatedUserId: string,
): CampusAction {
  return frozenJson({
    kind: "ccyl.cancel-signup",
    payload: {
      activityId: required(activityId, "activityId"),
      userId: required(authenticatedUserId, "authenticated CCYL userId"),
    },
  });
}
export function prepareCcylSubscription(
  libraryId: string,
  cancel = false,
): CampusAction {
  return frozenJson({
    kind: cancel ? "ccyl.cancel-subscribe" : "ccyl.subscribe",
    payload: { libraryId: required(libraryId, "libraryId") },
  });
}

/** Structural subset of original ServiceSchema, not an invented form field protocol.
 * Host must fetch start-data + get-formv and resolve this schema itself.
 * Complex schemas fail closed until the original full engine is ported.
 */
export interface SimpleServiceSchema {
  appId: string;
  formId: string;
  formVersionId: string;
  auth: Readonly<Record<string, string>>;
  data: Readonly<Record<string, unknown>>;
  showHide?: readonly unknown[];
  fields: readonly {
    key: string;
    type: string;
    required: boolean;
    readOnly: boolean;
    suppressed: boolean;
    options: readonly { value: string; name: string }[];
  }[];
}
export function prepareServiceSubmit(
  schema: SimpleServiceSchema,
  starterDepartId: string,
  values: Readonly<Record<string, unknown>>,
): CampusAction {
  required(schema.appId, "schema appId");
  required(schema.formId, "schema formId");
  required(schema.formVersionId, "schema version");
  required(starterDepartId, "server-selected department");
  const supported = new Set([
    "input",
    "multiInput",
    "radio",
    "select",
    "selectV2",
    "checkbox",
  ]);
  if (
    (schema.showHide?.length ?? 0) > 0 ||
    schema.fields.some(
      (f) => !supported.has(f.type) || f.suppressed || f.readOnly,
    )
  )
    throw new Error(
      "Unsupported dynamic form: complex/read-only/hidden fields require original schema engine; nothing submitted",
    );
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(values))
    if (!Object.hasOwn(schema.auth, key))
      throw new Error(`Unknown form field: ${key}`);
  for (const key of Object.keys(schema.auth)) {
    const field = schema.fields.find((f) => f.key === key);
    if (!field || !["editable", "require"].includes(schema.auth[key]))
      throw new Error(`Unsupported field permission: ${key}`);
    const value =
      values[key] ?? schema.data[key] ?? (field.type === "checkbox" ? [] : "");
    if (
      field.type === "checkbox"
        ? !Array.isArray(value) || value.some((x) => typeof x !== "string")
        : typeof value !== "string"
    )
      throw new Error(`Invalid value type: ${key}`);
    if (
      (field.required || schema.auth[key] === "require") &&
      (Array.isArray(value) ? !value.length : !(value as string).trim())
    )
      throw new Error(`Required field: ${key}`);
    const option = (v: string) => {
      const found = field.options.find((o) => o.value === v);
      if (!found) throw new Error(`Invalid option for ${key}`);
      return { value: v, name: found.name };
    };
    if (field.type === "checkbox")
      result[key] = (value as string[]).map(option);
    else if (field.type === "selectV2")
      result[key] = value === "" ? [] : [option(value as string)];
    else if (field.type === "select" || field.type === "radio")
      result[key] = value === "" ? "" : option(value as string);
    else result[key] = value;
  }
  return frozenJson({
    kind: "service.submit",
    payload: {
      appId: schema.appId,
      starterDepartId,
      formData: { [schema.formId]: result },
    },
  });
}
