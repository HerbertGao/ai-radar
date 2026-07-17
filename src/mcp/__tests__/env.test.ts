/**
 * MCP 宽松 env 解析单测（add-model-radar-recommender-rag-explanation 5e / task 1.2）。
 *
 * 焦点：`MR_RECOMMEND_EXPLAIN` 是可选枚举，走 `.catch(undefined)` **非致命款式**——mcpEnvSchema 是整对象
 * safeParse，非法枚举值 MUST NOT 炸掉纯查询进程（连累 DATABASE_URL 等 required 字段一起 fail）。
 * 非法值按未设置处理 + 发一行 stderr、server 照常启动。纯函数测（注入 raw，不触 process.env 单例）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMcpEnv } from '../env.js';

const DB = 'postgres://u:p@localhost:5432/test';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseMcpEnv · MR_RECOMMEND_EXPLAIN 非致命枚举', () => {
  it('非法值（如 LLM）不炸解析：ok=true、值按未设置（undefined）、发一行 stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = parseMcpEnv({ DATABASE_URL: DB, MR_RECOMMEND_EXPLAIN: 'LLM' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.env.MR_RECOMMEND_EXPLAIN).toBeUndefined(); // 按未设置处理
    expect(r.env.DATABASE_URL).toBe(DB); // required 字段不被连累
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toContain('MR_RECOMMEND_EXPLAIN');
  });

  it('合法值 llm / template 保留、不刷 stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rl = parseMcpEnv({ DATABASE_URL: DB, MR_RECOMMEND_EXPLAIN: 'llm' });
    const rt = parseMcpEnv({ DATABASE_URL: DB, MR_RECOMMEND_EXPLAIN: 'template' });
    expect(rl.ok && rl.env.MR_RECOMMEND_EXPLAIN).toBe('llm');
    expect(rt.ok && rt.env.MR_RECOMMEND_EXPLAIN).toBe('template');
    expect(spy).not.toHaveBeenCalled();
  });

  it('未设置 ⇒ undefined、不刷 stderr（三态可分：由调用方按缺 ⇒ 模板处理）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = parseMcpEnv({ DATABASE_URL: DB });
    expect(r.ok && r.env.MR_RECOMMEND_EXPLAIN).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('LLM_MODEL 可选、给了即透传（llm 解释层四凭据之一）', () => {
    const r = parseMcpEnv({ DATABASE_URL: DB, LLM_MODEL: 'openai/gpt-4o-mini' });
    expect(r.ok && r.env.LLM_MODEL).toBe('openai/gpt-4o-mini');
  });

  it('DATABASE_URL 缺失仍 fail-fast（非致命枚举不掩盖 required 字段缺失）', () => {
    const r = parseMcpEnv({ MR_RECOMMEND_EXPLAIN: 'LLM' });
    expect(r.ok).toBe(false);
  });
});
