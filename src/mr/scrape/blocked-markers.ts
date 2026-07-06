/**
 * blocked-page 标记（登录墙/验证码/滑块/人机校验/403/forbidden/robot 拦截页）的**唯一事实源**。
 *
 * 两处消费同一子串启发式：`fingerprint.ts`（D8：检测层，判 200 拦截页 → 不更新指纹）与
 * `curation/extract.ts`（D6：抽取层，价区命中 → 无候选、escalate）。共享一份，防两处手维护漂移。
 *
 * 短语级（非裸「登录」/「login」/「forbidden」——每页导航都有登录链接、正文可含这些词，裸词会误伤合法价页）。
 * 全小写：两处消费者均对已 `toLowerCase()` 的文本做 `includes` 匹配（中文大小写不敏感）。
 */
export const BLOCKED_MARKERS: readonly string[] = [
  // 验证码 / 人机校验 / 滑块（中英）
  '验证码',
  '人机验证',
  '人机校验',
  '滑动验证',
  '拖动滑块',
  '安全验证',
  'captcha',
  'verify you are human',
  'are you a robot',
  "i'm not a robot",
  'unusual traffic',
  'checking your browser',
  'cf-challenge',
  'attention required',
  // 登录墙（短语级，避开导航「登录」链接误报）
  '请先登录',
  '请登录后',
  '登录后查看',
  'please log in',
  'please sign in',
  'you must be logged in',
  'login required',
  // 403 / 拒绝访问（'forbidden' 不裸放——短语级 '403 forbidden' 已覆盖真拦截页，裸词会误伤正文含 forbidden 的合法页）
  '403 forbidden',
  'access denied',
  '拒绝访问',
  '访问被拒绝',
];
