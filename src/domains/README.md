# Internal campus read adapters

Protocol source: MingYuanHu `src/main/scu/{zhjw,zhjw-extras,wfw,fitness,service,cloudprint,ccyl,repair,notices,academic-calendar}.ts` (AGPL-3.0-or-later). No endpoints are inferred. Use `dispatchCampusRead(transport, domain, action, input)` as the host/agent boundary; per-module `create*` factories are internal typed adapters, not tools. Factories have invocation-local state; do not retain them across account changes. Transport and authentication headers never form tool results. Dispatch recursively removes authentication field names.

| Domain         | Action                         | Input fields                                                                                |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| exams          | list                           | none                                                                                        |
| classroom      | index                          | none                                                                                        |
| classroom      | types                          | campusNumber, buildingNumber, campusName, buildingName                                      |
| classroom      | availability                   | campusNumber, date; optional buildingNumber, classroomType, classroomName, seatFrom, seatTo |
| program        | colleges / grades / completion | none                                                                                        |
| program        | search                         | optional college, grade                                                                     |
| program        | detail                         | fajhh                                                                                       |
| classSchedule  | options                        | none                                                                                        |
| classSchedule  | subjects                       | departmentNum                                                                               |
| classSchedule  | search                         | optional plan, year, department, subject, classNum, page, pageSize                          |
| classSchedule  | schedule                       | planCode, classCode                                                                         |
| courseSchedule | options                        | none                                                                                        |
| courseSchedule | search                         | optional semester, department, name, code, seq, category, page, pageSize                    |
| courseSchedule | schedule                       | planCode, courseCode, courseSequenceCode                                                    |
| card           | history                        | optional sdate, edate                                                                       |
| fitness        | notices                        | none                                                                                        |
| fitness        | score                          | year (integer, required)                                                                    |
| service        | applications                   | optional status (default 0), page                                                           |
| cloudprint     | status / jobs                  | none                                                                                        |
| ccyl           | search                         | optional page, pageSize, name, level, scoreType, org, order, status, quality                |
| ccyl           | mine / credits                 | optional page, pageSize                                                                     |
| ccyl           | ordered                        | optional page, pageSize, name                                                               |
| ccyl           | library / detail               | id                                                                                          |
| ccyl           | scoreTypes                     | libraryId                                                                                   |
| ccyl           | orgs                           | none                                                                                        |
| repair         | mine                           | none; derives userId internally from own common addresses                                   |
| notices        | list                           | optional page (1–20)                                                                        |
| notices        | detail                         | url containing verified info/N/N.htm path; host remains fixed                               |
| calendar       | get                            | none                                                                                        |

Pagination is bounded (pageSize <= 100). All identifiers and dates are strings unless stated otherwise. Read-only POSTs are retained exactly as the source requires. SSO/session establishment is allowed; no submissions, verifyRoom, read receipts, subscriptions, uploads, exports to email or arbitrary-path requests are included.

## Limits

- Repair requires exactly one nonempty userId across current-account common addresses. If identity cannot be established, fails explicitly rather than allowing caller-supplied userId or guessing an endpoint.
- Notice body text is already decoded by CampusTransport. Its string-only response cannot recover bytes incorrectly decoded upstream; host must handle declared GBK/GB18030/UTF-8. Current upstream site was UTF-8 according to source.
- Calendar reads the original mirror then origin, with no disk writes or persistent cache.
- Arbitrary training-program course-detail paths are intentionally not exposed: the original generic path helper has no narrow read-only route contract.
- Fixtures verify protocol and safety without accounts/network; no live-system availability is claimed.
