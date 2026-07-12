/**
 * 对话 RAG Web 出口 `/advisor`（add-conversational-rag / Plan A A3，tasks 3.1–3.4，design D10/D11 /
 * spec「公开 Web 出口多层防护与最小下限」）。挂现有 Hono app（`src/app.ts` 同进程，与 Model Radar web 并存）。
 *
 * 多轮 chat：GET 展示会话历史 + 输入框；POST 提交 → 调 KB-RAG handler → 渲染本轮（答 + 引用 + 检索轨迹）。
 * `conversation_id` **服务端生成**（cookie 承载、贯穿会话）；`userId` 本期恒 `'local'`，**绝不信客户端传 userId**。
 *
 * 多层安全（承重层是 in-app JWT，design D10）：
 * - 请求先过 `cfAccessJwt`（挂 `/advisor` + `/advisor/*`，跑在 daily-cap 与任何 LLM 调用**之前**）——
 *   直连绕过边缘 CF Access 亦被拦；未配置 → fail-closed 拒绝服务（见 jwt-middleware.ts）。
 * - **渲染一律纯转义**（Hono JSX 默认转义子节点，含 trace 内 LLM 派生字段 `rewrittenQuery`）；
 *   **绝不 `dangerouslySetInnerHTML`/`raw()` LLM 输出**；散文答案 `white-space: pre-wrap` 保换行、
 *   **不用 markdown 自动链接**（否则散文里裸钓鱼 URL 变可点）；`source_url` 经 `safeHref`（scheme + userinfo 闸）。
 * - CSP `default-src 'none'`（无脚本、无外部取数）+ `form-action 'self'` + `frame-ancestors 'none'`。
 *
 * 最小成本/输入下限（design D11）：`query` 超 `RAG_MAX_QUERY_CHARS` 拒绝；每日 LLM 调用上限
 * `RAG_DAILY_LLM_CALL_CAP` 越限/Redis 不可用 → fail-closed 停止作答（均不发起 LLM）。
 *
 * 可测性：`jwt`/`handleFn`/`readHistoryFn`/`checkCapFn`/`newConversationId`/`maxQueryChars` 全可注入
 * （6.4 测试注入静态密钥 JWT + fake handler/cap，不触网/不触真 JWKS/真 Redis/真 LLM）。
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { FC, PropsWithChildren } from 'hono/jsx';
import { getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { env } from '../../config/env.js';
import { safeHref } from '../../mr/web/render.js';
import { handle, type HandlerContext, type HandlerResult } from '../handler.js';
import {
  readHistory,
  newConversationId as mintConversationId,
  ConversationConflictError,
  type ConversationTurn,
} from '../conversation-store.js';
import { checkAndBumpDailyCap, type DailyCapResult } from '../daily-cap.js';
import { cfAccessJwtFromEnv } from '../jwt-middleware.js';
import type { Citation } from '../citations.js';

/** 隔离谓词值（本期恒 'local'；未来绑已验证 CF Access JWT claim，绝不取客户端值）。 */
const USER_ID = 'local';
/** 服务端生成的 conversation_id 承载 cookie（贯穿一次会话）。 */
const CONV_COOKIE = 'advisor_conversation';
/** 服务端签发的 conversation_id 格式（randomUUID v4）——只信此格式，拒客户端伪造/超长值。 */
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// default-src 'none' 收口一切未声明取数（无脚本、无外部）；style-src 容内联 <style>；form-action 'self'
// 限提交去向；base-uri/frame-ancestors 补纵深（防 <base> 劫持 / 点击劫持）。无 JS、无外部资源。
const CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const PAGE_CSS = `
  :root { color-scheme: light dark; --bg:#f5f6f8; --surface:#fff; --ink:#14171c; --muted:#5b616b;
    --ring:#d9dde3; --accent:#1d4ed8; --q-bg:#eef2ff; --a-bg:#f7f8fa; --warn:#8a5a00; --warn-bg:#fff6e6; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e1116; --surface:#161a21; --ink:#e9ecf1; --muted:#a2a9b4;
    --ring:#2a2f38; --accent:#7aa2ff; --q-bg:#1b2438; --a-bg:#1a1e26; --warn:#ffcf85; --warn-bg:#2a2115; } }
  * { box-sizing: border-box; }
  body { font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    margin: 0; color: var(--ink); background: var(--bg); }
  a { color: var(--accent); }
  a:focus-visible, summary:focus-visible, button:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px; }
  .skip-link { position:absolute; left:-9999px; top:0; background:var(--ink); color:var(--surface); padding:.5rem 1rem; z-index:10; }
  .skip-link:focus { left:0; }
  header.site { max-width: 820px; margin: 0 auto; padding: 2rem 1.1rem 1rem; }
  header.site h1 { font-size: 1.5rem; margin: 0 0 .3rem; letter-spacing: -.02em; }
  header.site p { margin: 0; color: var(--muted); font-size: .92rem; max-width: 60ch; }
  main { max-width: 820px; margin: 0 auto; padding: 0 1.1rem 3rem; }
  .empty { color: var(--muted); padding: 1.5rem 0; }
  ol.conversation { list-style: none; margin: 1rem 0; padding: 0; display: grid; gap: 1.4rem; }
  .turn { display: grid; gap: .6rem; }
  .role { display: inline-block; font-size: .74rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-bottom: .2rem; }
  .q, .a { padding: .85rem 1rem; border-radius: 12px; border: 1px solid var(--ring); }
  .q { background: var(--q-bg); }
  .a { background: var(--a-bg); }
  .q-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .a-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .a-note { margin: 0; color: var(--muted); font-style: italic; }
  .citations { margin: .8rem 0 0; padding-top: .7rem; border-top: 1px dashed var(--ring); }
  .cite-h { font-size: .74rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
  .citations ol { margin: .4rem 0 0; padding-left: 1.2rem; display: grid; gap: .4rem; }
  .cite-snip { display: block; overflow-wrap: anywhere; }
  .muted { color: var(--muted); }
  details.trace { margin: .7rem 0 0; font-size: .86rem; }
  details.trace summary { cursor: pointer; color: var(--muted); }
  details.trace dl { margin: .5rem 0 0; display: grid; grid-template-columns: auto 1fr; gap: .25rem .8rem; }
  details.trace dt { font-weight: 600; color: var(--muted); }
  details.trace dd { margin: 0; overflow-wrap: anywhere; }
  .banner { margin: 1rem 0; padding: .75rem 1rem; border-radius: 10px; background: var(--warn-bg);
    color: var(--warn); border: 1px solid var(--warn); font-weight: 600; }
  form.ask { margin: 1.5rem 0 0; display: grid; gap: .7rem; }
  form.ask textarea { width: 100%; min-height: 5.5rem; padding: .7rem .85rem; font: inherit; color: var(--ink);
    background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; resize: vertical; }
  form.ask button { justify-self: start; min-height: 40px; padding: .55rem 1.5rem; font: 600 1rem/1 inherit;
    color: #fff; background: var(--accent); border: 1px solid var(--accent); border-radius: 10px; cursor: pointer; }
`;

/** 页面外壳（lang/title/CSP-friendly 内联样式/地标/skip-link）。 */
const Shell: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="zh-Hans">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{PAGE_CSS}</style>
    </head>
    <body>
      <a class="skip-link" href="#main">
        跳到主内容
      </a>
      <header class="site">
        <h1>AI 情报问答</h1>
        <p>基于知识库证据、带引用作答。价格 / 额度 / 选型属精确事实，请用 Model Radar；本助手只答「是什么 / 背景」。</p>
      </header>
      <main id="main" tabindex={-1}>
        {children}
      </main>
    </body>
  </html>
);

/** 引用来源链接：**再过一次 `safeHref`**（纵深防御；buildCitations 已过一次，此为渲染层单一 XSS 闸）。 */
const CiteLink: FC<{ url: string }> = ({ url }) => {
  const href = safeHref(url);
  return href ? (
    <a href={href} rel="noopener noreferrer">
      查看来源
    </a>
  ) : (
    <span class="muted">（无可链接来源）</span>
  );
};

/** 本轮程序构造引用（snippet + source_url 均来自命中行、非 LLM；见 citations.ts）。 */
const CitationList: FC<{ citations: Citation[] }> = ({ citations }) => (
  <div class="citations">
    <span class="cite-h">引用证据</span>
    <ol>
      {citations.map((cit) => (
        <li>
          {cit.snippet ? <span class="cite-snip">{cit.snippet}</span> : null}
          {cit.source_url ? <CiteLink url={cit.source_url} /> : <span class="muted">（无可链接来源）</span>}
        </li>
      ))}
    </ol>
  </div>
);

/** 检索轨迹（**向用户披露本轮实际检索句 rewrittenQuery** + 命中条目；LLM 派生字段纯转义，design D6/D10）。 */
const TraceView: FC<{ turn: ConversationTurn }> = ({ turn }) => (
  <details class="trace">
    <summary>检索轨迹</summary>
    <dl>
      <dt>实际检索句</dt>
      <dd>{turn.rewrittenQuery ?? turn.rawQuery ?? ''}</dd>
      <dt>命中知识库条目</dt>
      <dd>{turn.hitKbIds && turn.hitKbIds.length > 0 ? turn.hitKbIds.join('、') : '无'}</dd>
    </dl>
  </details>
);

/** 单轮：问 + 答（或诚实降级提示）+ 本轮引用（仅当轮提供）+ 检索轨迹。全部纯转义。 */
const TurnView: FC<{ turn: ConversationTurn; citations?: Citation[]; domain?: HandlerResult['domain'] }> = ({
  turn,
  citations,
  domain,
}) => {
  const hasAnswer = turn.answer !== null && turn.answer.trim().length > 0;
  return (
    <li class="turn">
      <div class="q">
        <span class="role">你</span>
        <p class="q-text">{turn.rawQuery ?? ''}</p>
      </div>
      <div class="a">
        <span class="role">助手</span>
        {hasAnswer ? (
          <p class="a-text">{turn.answer}</p>
        ) : (
          <p class="a-note">
            {domain === '非我域'
              ? '这属于价格 / 额度 / 选型（精确事实），本助手不作价格判断——请到 Model Radar 比价选型。'
              : '未找到足够相关的知识库证据，本轮不作答（诚实降级、不杜撰）。'}
          </p>
        )}
        {citations && citations.length > 0 ? <CitationList citations={citations} /> : null}
        <TraceView turn={turn} />
      </div>
    </li>
  );
};

interface PageProps {
  turns: ConversationTurn[];
  /** 本轮（最后一轮）程序构造引用——仅 POST 有；历史轮不存引用（只存 hit_kb_ids 指针）。 */
  currentCitations?: Citation[];
  /** 本轮 domain（区分 非我域 vs 本域无据 的提示文案）。 */
  currentDomain?: HandlerResult['domain'];
  /** 拒绝/错误横幅（超长 / 越限 / 出错）。 */
  error?: string;
  /** 回填输入框（拒绝后保留用户已输入，便于缩短重试）。 */
  draft?: string;
}

const AskForm: FC<{ draft?: string }> = ({ draft }) => (
  <form class="ask" method="post" action="/advisor">
    <label>
      <span class="role">问点什么</span>
      <textarea name="query" rows={4} placeholder="例如：最近 Anthropic 发布了什么？">
        {draft ?? ''}
      </textarea>
    </label>
    <button type="submit">提问</button>
  </form>
);

const Page: FC<PageProps> = ({ turns, currentCitations, currentDomain, error, draft }) => {
  const lastIndex = turns.length - 1;
  return (
    <>
      {error ? (
        <p class="banner" role="alert">
          {error}
        </p>
      ) : null}
      {turns.length === 0 ? (
        <p class="empty">还没有对话。在下方提问开始。</p>
      ) : (
        <ol class="conversation">
          {turns.map((turn, i) => (
            <TurnView
              turn={turn}
              {...(i === lastIndex && currentCitations ? { citations: currentCitations } : {})}
              {...(i === lastIndex && currentDomain ? { domain: currentDomain } : {})}
            />
          ))}
        </ol>
      )}
      <AskForm {...(draft !== undefined ? { draft } : {})} />
    </>
  );
};

async function renderDoc(props: PageProps): Promise<string> {
  const doc = await (
    <Shell title="AI 情报问答 · Advisor">
      <Page {...props} />
    </Shell>
  );
  return '<!DOCTYPE html>' + doc;
}

/** 注入点（默认真实实现；6.4 测试注入 no-network 桩）。 */
export interface AdvisorDeps {
  /** JWT 中间件（默认从 env 构造 CF Access 校验；测试注入静态密钥 no-network 版）。 */
  jwt?: MiddlewareHandler;
  /** KB-RAG handler（默认 handle；测试注入 fake，避开真 LLM/DB）。 */
  handleFn?: (query: string, ctx: HandlerContext) => Promise<HandlerResult>;
  /** 历史读回（默认 readHistory；测试注入固定历史）。 */
  readHistoryFn?: (userId: string, conversationId: string) => Promise<ConversationTurn[]>;
  /** 每日成本地板检查（默认 Redis INCR；测试注入 fake，含 fail-closed 桩）。 */
  checkCapFn?: () => Promise<DailyCapResult>;
  /** conversation_id 服务端生成（默认 randomUUID；测试可固定）。 */
  newConversationId?: () => string;
  /** query 长度上限（默认 env.RAG_MAX_QUERY_CHARS）。 */
  maxQueryChars?: number;
}

/**
 * 构造挂载了 `/advisor` 多轮 chat + 多层安全的 Hono app。默认真实实现（JWT/handler/cap 全走 env 与 Redis）。
 */
export function createAdvisorApp(deps: AdvisorDeps = {}): Hono {
  const jwt = deps.jwt ?? cfAccessJwtFromEnv();
  const handleFn = deps.handleFn ?? ((q, ctx) => handle(q, ctx));
  const readHistoryFn = deps.readHistoryFn ?? ((u, c) => readHistory(u, c));
  const checkCapFn = deps.checkCapFn ?? (() => checkAndBumpDailyCap());
  const mintId = deps.newConversationId ?? mintConversationId;
  const maxChars = deps.maxQueryChars ?? env.RAG_MAX_QUERY_CHARS;

  const app = new Hono();

  // in-app JWT 挂 `/advisor` 与其子路径（跑在 cap/LLM 之前）；不挂公开只读的 Model Radar 路由。
  app.use('/advisor', jwt);
  app.use('/advisor/*', jwt);
  // 原始请求体上限（在 parseBody 之前挡超大 body，纵深防御——RAG_MAX_QUERY_CHARS 是解析后的字段级上限）。
  // ponytail: 固定 64KiB 对一条 <=maxChars 的 query 绰绰有余；真需更大表单再调。
  app.use('/advisor', bodyLimit({ maxSize: 64 * 1024 }));
  app.use('/advisor/*', bodyLimit({ maxSize: 64 * 1024 }));

  const setSecurityHeaders = (c: Context): void => {
    c.header('Content-Security-Policy', CSP);
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
  };

  /** 从 cookie 取会话 id，缺则服务端新生成（绝不信客户端 userId；conversation_id 服务端生成）。 */
  const resolveConversation = (c: Context): { id: string; fresh: boolean } => {
    const existing = getCookie(c, CONV_COOKIE);
    // 只信服务端签发格式（UUID）的 conversation_id；客户端伪造/超长值一律当新会话服务端重签
    // （守「conversation_id 服务端生成、不信客户端」契约 + 防超长值撞 varchar(128) 列约束报 500）。
    // 注：多用户落地时须把 conversation_id 归属绑到已验证 JWT claim（design 非目标、seam 预留）。
    if (existing && CONVERSATION_ID_RE.test(existing)) return { id: existing, fresh: false };
    return { id: mintId(), fresh: true };
  };
  const persistConversation = (c: Context, id: string): void => {
    setCookie(c, CONV_COOKIE, id, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,
      path: '/advisor',
    });
  };

  app.get('/advisor', async (c) => {
    setSecurityHeaders(c);
    const { id, fresh } = resolveConversation(c);
    if (fresh) persistConversation(c, id);
    const turns = fresh ? [] : await readHistoryFn(USER_ID, id);
    return c.html(await renderDoc({ turns }));
  });

  app.post('/advisor', async (c) => {
    setSecurityHeaders(c);
    const { id, fresh } = resolveConversation(c);
    if (fresh) persistConversation(c, id);

    const body = await c.req.parseBody();
    const query = typeof body.query === 'string' ? body.query : '';

    // ── 输入下限：query 长度上限（信任边界，超限拒绝、绝不触发 LLM，design D11）──
    if (query.length > maxChars) {
      const turns = await readHistoryFn(USER_ID, id);
      return c.html(
        await renderDoc({
          turns,
          error: `问题过长（${query.length} 字，上限 ${maxChars} 字），已拒绝。请缩短后重试。`,
          draft: query,
        }),
        400,
      );
    }
    if (query.trim().length === 0) {
      const turns = await readHistoryFn(USER_ID, id);
      return c.html(await renderDoc({ turns, error: '请输入问题。' }), 400);
    }

    // ── 成本地板：每日 LLM 调用上限（越限或 Redis 不可用 → fail-closed，不发起作答，design D11）──
    const cap = await checkCapFn();
    if (!cap.allowed) {
      const turns = await readHistoryFn(USER_ID, id);
      return c.html(
        await renderDoc({
          turns,
          error: '已达当日问答上限（或计数服务暂不可用），本轮不作答，请稍后再试。',
          draft: query,
        }),
        429,
      );
    }

    // ── 作答（KB-RAG handler；写回会话由 handler 内完成）──
    let result: HandlerResult;
    try {
      result = await handleFn(query, { userId: USER_ID, conversationId: id });
    } catch (err) {
      const status = err instanceof ConversationConflictError ? 409 : 500;
      const turns = await readHistoryFn(USER_ID, id);
      return c.html(
        await renderDoc({ turns, error: '处理请求时出错，请稍后重试。', draft: query }),
        status,
      );
    }

    // 读回全量历史（含本轮）并渲染；本轮引用来自 live result（历史轮不存引用、只存指针）。
    const turns = await readHistoryFn(USER_ID, id);
    return c.html(
      await renderDoc({ turns, currentCitations: result.citations, currentDomain: result.domain }),
    );
  });

  return app;
}
