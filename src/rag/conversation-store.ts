/**
 * 对话 RAG 会话存档 store（add-conversational-rag / Plan A A3，design D3/D4）。
 *
 * 职责：读回历史轮（供 query-rewrite）/ 服务端派生 turn 写回一轮 / 服务端生成 conversation_id。
 * **只读写自有 `rag_conversations`，绝不写任何域库**（kb_documents / ai_news_events / mr_* / ai_products）。
 *
 * 守住的不变量（design D4）：
 * - **多用户隔离谓词今就发**：`readHistory` / `writeTurn` 的读写都带 `WHERE user_id = $ctx`（本期恒
 *   'local'）——多用户为改**值**（未来绑已验证 CF Access JWT claim）非改代码路径，隔离今就可测。
 * - `conversation_id` **服务端生成**（`newConversationId` = crypto.randomUUID），`turn` **服务端派生**
 *   （现有最大 turn + 1），二者绝不信客户端。
 * - **并发同 turn**：`UNIQUE(user_id, conversation_id, turn)` 冲突后**重试 turn+1**（不静默丢用户轮次、
 *   不 500），有界 ≤5 次后抛 `ConversationConflictError`（上层转 409）；防持续并发下 livelock。
 * - **指针式**：`hitKbIds` 存命中的 kb_id 数组引用，**绝不存 KB 正文拷贝**。
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { ragConversations } from '../db/schema.js';

/** db 句柄类型（drizzle 实例或事务），供依赖注入 / 集成测。 */
type DbLike = typeof defaultDb;

/** turn 冲突重试上限（有界，防持续并发下 livelock，design D4）。 */
const MAX_TURN_ATTEMPTS = 5;

/**
 * 会话轮次唯一约束持续冲突、超过重试上限——上层（/advisor handler）应转 HTTP 409。
 */
export class ConversationConflictError extends Error {
  readonly status = 409;
  constructor(
    message = '会话轮次唯一约束持续冲突，已超过重试上限（并发过高）',
  ) {
    super(message);
    this.name = 'ConversationConflictError';
  }
}

/** 一条历史轮（读回，供 query-rewrite；hitKbIds 为 kb_id 指针数组）。 */
export interface ConversationTurn {
  turn: number;
  rawQuery: string | null;
  rewrittenQuery: string | null;
  hitKbIds: string[] | null;
  answer: string | null;
  evidence: string | null;
  model: string | null;
  createdAt: Date | null;
}

/** 写一轮的入参（userId + 服务端生成的 conversationId 必带；turn 由 store 派生，不接受入参）。 */
export interface WriteTurnInput {
  userId: string;
  conversationId: string;
  rawQuery: string;
  rewrittenQuery?: string | null;
  /** 命中的 kb_id 指针数组（绝不存 KB 正文拷贝）。 */
  hitKbIds?: string[] | null;
  answer?: string | null;
  evidence?: string | null;
  model?: string | null;
}

/** 服务端生成 conversation_id（不信客户端）。 */
export function newConversationId(): string {
  return randomUUID();
}

/**
 * 读回某会话全部历史轮，按 turn 升序（供 query-rewrite）。带 `WHERE user_id` 隔离谓词。
 */
export async function readHistory(
  userId: string,
  conversationId: string,
  dbh: DbLike = defaultDb,
): Promise<ConversationTurn[]> {
  const rows = await dbh
    .select({
      turn: ragConversations.turn,
      rawQuery: ragConversations.rawQuery,
      rewrittenQuery: ragConversations.rewrittenQuery,
      hitKbIds: ragConversations.hitKbIds,
      answer: ragConversations.answer,
      evidence: ragConversations.evidence,
      model: ragConversations.model,
      createdAt: ragConversations.createdAt,
    })
    .from(ragConversations)
    .where(
      and(
        eq(ragConversations.userId, userId),
        eq(ragConversations.conversationId, conversationId),
      ),
    )
    .orderBy(asc(ragConversations.turn));

  return rows.map((r) => ({
    turn: Number(r.turn),
    rawQuery: r.rawQuery,
    rewrittenQuery: r.rewrittenQuery,
    hitKbIds: r.hitKbIds ?? null,
    answer: r.answer,
    evidence: r.evidence,
    model: r.model,
    createdAt: r.createdAt,
  }));
}

/**
 * 写一轮会话存档，服务端派生 turn（现有最大 + 1），返回落库的 turn。
 *
 * 并发同 turn：`UNIQUE(user_id, conversation_id, turn)` 冲突 → `onConflictDoNothing` 空 returning →
 * 重试 turn+1（不丢轮次）；有界 ≤5 次后抛 `ConversationConflictError`（409）。
 */
export async function writeTurn(
  input: WriteTurnInput,
  dbh: DbLike = defaultDb,
): Promise<number> {
  const { userId, conversationId } = input;

  // 派生起始 turn = 现有最大 turn + 1（带 WHERE user_id 隔离谓词）。
  // Number(...) 兜底：max(integer) 经 pg 驱动可能回传字符串，`?? 0` 后直接 + 1 会字符串拼接。
  const [maxRow] = await dbh
    .select({ maxTurn: sql<number | null>`max(${ragConversations.turn})` })
    .from(ragConversations)
    .where(
      and(
        eq(ragConversations.userId, userId),
        eq(ragConversations.conversationId, conversationId),
      ),
    );
  const baseTurn = Number(maxRow?.maxTurn ?? 0) + 1;

  for (let attempt = 0; attempt < MAX_TURN_ATTEMPTS; attempt++) {
    const turn = baseTurn + attempt;
    const inserted = await dbh
      .insert(ragConversations)
      .values({
        userId,
        conversationId,
        turn,
        rawQuery: input.rawQuery,
        rewrittenQuery: input.rewrittenQuery ?? null,
        hitKbIds: input.hitKbIds ?? null,
        answer: input.answer ?? null,
        evidence: input.evidence ?? null,
        model: input.model ?? null,
      })
      // UNIQUE 冲突 → 空 returning（非抛错），据此重试 turn+1（不丢轮次、不 500）。
      .onConflictDoNothing({
        target: [
          ragConversations.userId,
          ragConversations.conversationId,
          ragConversations.turn,
        ],
      })
      .returning({ turn: ragConversations.turn });

    if (inserted.length > 0) return Number(inserted[0]!.turn);
  }

  throw new ConversationConflictError();
}
