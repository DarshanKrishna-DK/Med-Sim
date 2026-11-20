// Hook that drives an end-of-encounter debrief through the medsim-attending
// Managed Agent, with an optional fallback (e.g. the simple single-call
// debrief at /agent/debrief/simple) when the Managed Agent path fails, is
// unconfigured, or doesn't produce an evaluation within `timeoutMs`.
//
// Lifecycle:
//   1. Caller passes a `DebriefRequest` (built via buildDebriefRequest).
//      The hook does nothing until `request` becomes non-null AND `enabled`
//      is true, that's the trigger.
//   2. bootstrap (idempotent), createSession, sendUserMessage with the
//      [debrief request] body, then openEventStream.
//   3. Auto-ack any `auto`-permission custom tool calls. Surface a
//      `render_case_evaluation` invocation as the final result (validated
//      via parseCustomToolUse).
//   4. Cleanup on unmount via AbortSignal.

import { useEffect, useRef, useState } from 'react';
import {
  bootstrap,
  createSession,
  sendCustomToolResult,
  sendUserMessage,
  openEventStream,
} from './managedAgent';
import {
  type CaseEvaluationInput,
  CUSTOM_TOOL_PERMISSIONS,
  parseCustomToolUse,
} from './customTools';
import {
  type DebriefRequest,
  debriefRequestToUserMessage,
} from './debriefRequest';
import type { SimpleDebrief } from './simpleDebrief';

export type DebriefStatus =
  | 'idle'
  | 'starting'
  | 'streaming'
  | 'got-evaluation'
  | 'error'
  | 'aborted';

export interface UseAttendingDebriefResult {
  status: DebriefStatus;
  evaluation: CaseEvaluationInput | null;
  error: string | null;
  /** Each `agent.message` `delta` text concatenated, for showing the
   *  agent's "thinking aloud" while it streams toward the eval emit. */
  partialNarration: string;
  /** Which path produced `evaluation` ('managed-agent' | 'simple'), or
   *  null while none has. */
  source: DebriefSource | null;
  /** Raw simple-debrief result when the fallback produced the evaluation. */
  simple: SimpleDebrief | null;
  /** Reset to allow a re-run with a new request. */
  reset: () => void;
}

export type DebriefSource = 'managed-agent' | 'simple';

export interface DebriefFallbackResult {
  evaluation: CaseEvaluationInput;
  simple?: SimpleDebrief;
}

interface Options {
  enabled?: boolean;
  /** Called when the Managed Agent path errors, closes without an eval,
   *  or times out. Its result becomes the evaluation (source 'simple'). */
  fallback?: (signal: AbortSignal) => Promise<DebriefFallbackResult>;
  /** Skip the Managed Agent entirely and go straight to `fallback`. */
  skipManagedAgent?: boolean;
  /** Give up on the Managed Agent after this long (default 90 s) and use
   *  the fallback, if one is provided. */
  timeoutMs?: number;
}

export function useAttendingDebrief(
  request: DebriefRequest | null,
  opts: Options = {},
): UseAttendingDebriefResult {
  const enabled = opts.enabled !== false;
  const [status, setStatus] = useState<DebriefStatus>('idle');
  const [evaluation, setEvaluation] = useState<CaseEvaluationInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partialNarration, setPartial] = useState('');
  const [source, setSource] = useState<DebriefSource | null>(null);
  const [simple, setSimple] = useState<SimpleDebrief | null>(null);
  // Fallback/options via ref so a new closure each render doesn't re-run
  // the effect.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // Effect deps the request reference directly; useMemo at the call site
  // stabilises it across non-load-bearing re-renders. Under React 18
  // StrictMode the effect fires twice in dev, the first run's cleanup
  // aborts its controller, the second run starts fresh. That's fine: each
  // run creates its own session.

  useEffect(() => {
    if (!enabled || !request) return;

    const ctrl = new AbortController();
    let cancelled = false;
    setStatus('starting');
    setError(null);
    setEvaluation(null);
    setPartial('');
    setSource(null);
    setSimple(null);

    const { fallback, skipManagedAgent, timeoutMs = 90_000 } = optsRef.current;

    const runFallback = async (why: string) => {
      if (!fallback || cancelled) return false;
      console.warn('[medsim:debrief] managed agent unavailable, using simple debrief:', why);
      setStatus('streaming');
      try {
        const res = await fallback(ctrl.signal);
        if (cancelled) return true;
        setEvaluation(res.evaluation);
        setSimple(res.simple ?? null);
        setSource('simple');
        setStatus('got-evaluation');
      } catch (e) {
        if (cancelled) return true;
        setStatus('error');
        setError(`${why}, fallback also failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return true;
    };

    void (async () => {
      if (skipManagedAgent && fallback) {
        await runFallback('managed agent skipped');
        return;
      }
      // Managed Agent attempt, raced against a timeout when a fallback exists.
      const agentCtrl = new AbortController();
      ctrl.signal.addEventListener('abort', () => agentCtrl.abort(), { once: true });
      let timer: number | undefined;
      try {
        const attempt = (async () => {
          await bootstrap();
          const sessionId = await createSession(`debrief-${request.case_id}-${Date.now()}`)
            .then((s) => s.session_id);
          if (cancelled || agentCtrl.signal.aborted) return { kind: 'aborted' } as StreamResult;

          const streamPromise = consumeStream(
            sessionId,
            agentCtrl.signal,
            (e) => {
              if (cancelled || agentCtrl.signal.aborted) return;
              setEvaluation(e);
              setSource('managed-agent');
            },
            (delta) => !cancelled && setPartial((p) => p + delta),
          );

          await sendUserMessage(sessionId, debriefRequestToUserMessage(request));
          if (!cancelled) setStatus('streaming');
          return streamPromise;
        })();
        attempt.catch(() => undefined); // may settle after a timeout
        const timeout = fallback
          ? new Promise<StreamResult>((_, reject) => {
              timer = window.setTimeout(
                () => reject(new Error(`managed agent timed out after ${Math.round(timeoutMs / 1000)}s`)),
                timeoutMs,
              );
            })
          : null;
        const result = await (timeout ? Promise.race([attempt, timeout]) : attempt);
        if (cancelled) return;
        if (result.kind === 'eval') setStatus('got-evaluation');
        else if (result.kind === 'aborted') setStatus('aborted');
        else if (result.kind === 'closed-without-eval') {
          if (await runFallback('agent closed without evaluation')) return;
          setStatus('error');
          setError('Agent stream closed without emitting a case evaluation.');
        }
      } catch (e) {
        if (cancelled) return;
        agentCtrl.abort();
        const msg = e instanceof Error ? e.message : String(e);
        if (await runFallback(msg)) return;
        setStatus('error');
        setError(msg);
      } finally {
        if (timer !== undefined) window.clearTimeout(timer);
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [enabled, request]);

  return {
    status,
    evaluation,
    error,
    partialNarration,
    source,
    simple,
    reset: () => {
      setStatus('idle');
      setEvaluation(null);
      setError(null);
      setPartial('');
      setSource(null);
      setSimple(null);
    },
  };
}

type StreamResult =
  | { kind: 'eval' }
  | { kind: 'closed-without-eval' }
  | { kind: 'aborted' };

async function consumeStream(
  sessionId: string,
  signal: AbortSignal,
  onEval: (e: CaseEvaluationInput) => void,
  onPartialDelta: (delta: string) => void,
): Promise<StreamResult> {
  let gotEval = false;
  const stream = openEventStream(sessionId, { signal });
  for await (const ev of stream) {
    if (signal.aborted) return { kind: 'aborted' };

    if (ev.type === 'agent.message') {
      const content = (ev as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block && typeof block === 'object' &&
            (block as { type?: unknown }).type === 'text'
          ) {
            const text = (block as { text?: unknown }).text;
            if (typeof text === 'string') onPartialDelta(text);
          }
        }
      }
      continue;
    }

    if (ev.type === 'agent.custom_tool_use') {
      const toolName = (ev as { name?: string }).name ?? '';
      const toolUseId = (ev as { id?: string }).id ?? '';
      const input = (ev as { input?: unknown }).input;
      const parsed = parseCustomToolUse(toolName, input);
      if (!parsed.ok) {
        // Reply with an error so the agent knows the input was bad, don't
        // crash the stream. The agent can choose to retry.
        await sendCustomToolResult(
          sessionId,
          toolUseId,
          `Validation error: ${parsed.error}`,
          true,
        );
        continue;
      }

      if (parsed.call.name === 'render_case_evaluation') {
        gotEval = true;
        onEval(parsed.call.input);
        await sendCustomToolResult(sessionId, toolUseId, 'rendered');
        continue;
      }

      const perm = CUSTOM_TOOL_PERMISSIONS[parsed.call.name];
      if (perm === 'auto') {
        await sendCustomToolResult(sessionId, toolUseId, 'rendered');
      }
      // confirm-gated tools: leave for the host UI to handle in this
      // debrief flow we don't expect them; ignore.
      continue;
    }
  }
  return gotEval ? { kind: 'eval' } : { kind: 'closed-without-eval' };
}
