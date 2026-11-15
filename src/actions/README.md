# 校园写操作安全边界与移植报告

## Host 接入合同

- `ActionDraftStore<CampusAction, RemoteContext>` 不依赖 DSH；构造参数 `{ authorize(context): ActionBinding | null, dispatch(action,binding): Promise<DispatchResult>, ttlMs?, now?, maxDrafts? }`。
- `ActionBinding = { ownerId, accountId, sessionGeneration }` 必须由 Host 取得。`prepare(binding,action)` 是唯一可供 agent 间接调用的能力。不要把整个 store、authorize 或 dispatcher 注册为 agent tool。
- `inspect(id,context)` / `commit(id,context)` 只从经认证的 owner UI Remote 调用；`authorize` 必须依据 Remote 连接的真实 owner 身份，不可相信 Remote JSON 中的 ownerId、confirmed、account 或 generation。无 owner UI 时拒绝，绝不 fallback 到 agent 自确认。
- UI 展示 action 全部字段并提供明确确认按钮；commit 只发送 draft ID，不收 payload。返回 UI/agent 的 DTO 应剔除 binding（尤其 accountId）并避免把个人地址/手机号写日志。内部草稿包括 binding，勿直接对外序列化。
- 默认 TTL 五分钟，上限100份；deep-copy/freeze 保证 prepare 之后不能改 payload。commit 在 await 前消费 draft，并阻止重复/并发提交。错误或无法识别的响应为 unknown，不重试；用户先在校园查询接口核对，不应自动创建新草稿重发。
- logout/account change 时调用 invalidateAccount。更重要的是 authorize 必须返回当前 generation；transport.session 和 request 必须核对同一 binding。request 期间不可切到另一账号的全局 jar；建议账户级隔离/会话锁。transport 必须禁止业务写请求 auth replay、网络重试、重定向重放。
- 模块没有默认网络实现；所有网络经注入 ActionTransport。session 可在写请求前预热认证；request 一次请求。当前模块不实现 SSO/token 缓存，Host 负责。repairTokenKey/ccylToken 仅保留在 Host，不进 draft。

## 核实原协议后实现的操作

来源：原 MingYuanHu 的 src/main/scu/repair.ts、ccyl.ts、service.ts、service-form.ts（相关 schema 与序列化段）、cloudprint.ts、passpoint.ts。

- 报修发布：POST https://zhhq.scu.edu.cn/api/repair/publish/publish，JSON 字段与原 submitRepair 相同；地址必须来自 getCommonAddress，项目取 getProjectByAreaId 叶子 value 与完整分类名称。可选 department 由 getAcceptUserByAreaIdAndProjectId 读取。预约日期/时段应由 Host 查询候选后确认，不推测。
- 报修撤回：POST /api/repair/myRepair/withdrawMyRepair，urlencoded id，使用列表 activeId 而非行 id。
- 报修请求 Token 为 AES-128-CBC(JSON({tokenKey,clientId,timestamp,GUID}))，公开 key=bf8ec0449942e7f4，iv/clientId=web201911chengdu；响应 AES key/iv=1974051005060708。TokenKey 也在请求头。不复制原实现可能重放的 retry wrapper。
- 二课报名 POST /ccyl-api/app/activity/sign-up-act，{activityId,scoreType}。取消报名 POST /app/activity/cancel，{activityId,userId}；userId 从 Host 登录响应获得，并在提交时再次与会话核对。
- 二课订阅/取消：POST /app/activity/subscribe-act/{encoded libraryId}、/app/activity/cancel-subscribe/{encoded libraryId}，空 JSON。使用 token 头；HTTP200 且 code=0 才成功。
- 办事大厅：POST https://service.scu.edu.cn/site/process/launch，urlencoded data=JSON({app_id,node_id:'',form_data,userview:1}),step='0',agent_uid='',starter_depart_id。HTTP200 且 e=0 才成功。
- 动态表单必须由 Host 完整读取 select-department → start-info/start-data → get-formv（原 plugins 双层编码），得到真实 ServiceSchema。本模块只接收结构兼容的已解析 schema，按原 formId 外层映射与 option {value,name} 序列化，不自行猜插件字段。只支持 input/multiInput/radio/select/selectV2/checkbox，权限 require/显式 editable；只读、隐藏、未知权限、showHide、calendar/region/dataSource/user/validate/repeatTable 等全部明确拒绝。当前没有迁移原完整动态引擎，也没有声称可提交任意事项。原预填选项对象必须先由原 defaultServiceValues 转成字符串，不能猜测强转。

## 文件与浏览器限制（明确未实现）

- 报修原图片上传 POST /api/file/upload，multipart system=manager,file，最多3张，每张10MiB，仅 jpg/jpeg/png/heic/heif，响应 data.path。当前 prepareRepairSubmit 拒绝所有非空 images；不读取路径，不进行上传。将来需 owner 文件选择能力、大小/类型/内容快照绑定和单独上传确认；已上传服务器引用也须校验归属与明确确认，不可任意引用 agent 提供 URL。
- 办事大厅原附件 POST /site/attach/auth-upload，multipart upfile，100MiB 上限，返回 {name,url,id}。当前 file schema 拒绝，未实现附件上传。
- 云打印原上传是 HTTP 明文 http://202.115.54.240/api/client/CloudPrint/Upload，multipart szPath + dwColor/dwPaperId/dwDuplex/dwCopies/dwFrom/dwTo + BackURL。上传即建立任务，可能涉及费用及文件内容泄露；必须明确提示 HTTP 明文及费用、owner选文件并绑定字节快照。不能以查询/prepare 名义上传。不迁移此写接口。
- passpoint 原实现依赖 Electron 隐藏 BrowserWindow 真实导航及前端初始化产生 process_uid；纯 HTTP 中继不能替代。该模块不导入 Electron、不打开浏览器、不偷偷预热。需将来明确 owner 授权的浏览器能力；目前不可用。原写路径 add-user-mab-info/cancel-user-mab-info 不注册。

## 验证

测试全为 mock，无真实校园写请求，无上传，无打开浏览器。覆盖 forged confirmed、跨owner/account/generation、到期边界、冻结/分离payload、重复及并发提交、未知结果不重试、退出清理、真实协议字段及路径、复杂 schema fail closed。
