"""Autonomous live voice agents: tools run inside our custom LLM endpoint.

Agora "tool calling" recipe (recipes.agora.io/recipes/tool-calling): the
Conversational AI engine calls our OpenAI-compatible /llm proxy every turn;
the proxy, not the browser, decides whether the turn needs a tool. For a
bearer token tagged with a registered kind (llm_proxy token meta) the turn
comes here:

  1. sanitize the messages, add the toolset's system addendum and a note of
     the actions already taken in this session (so the model never repeats them)
  2. call the provider non-streaming WITH the toolset's tools (each LLM round
     and each tool bounded to STEP_TIMEOUT_S, at most `max_rounds` rounds)
  3. speak a short filler line first while tools run, execute the calls
     server-side, feed the results back, repeat
  4. stream the final assistant text back as OpenAI SSE so Agora / Murf
     speaks it. Any failure speaks a safe fallback line, never an error.

Every tool call is published to the session's event bus (agent_events) as
a "tool" event, and toolsets publish UI events of their own (whiteboard,
quiz, viva grade...). Side-effect tools are deduped per session.

The registry maps kind -> AgentToolset. Kinds: followup (Asha's follow-up
call, delegates to followup_tools.handle unchanged), receptionist,
teacher, viva-examiner (agent_toolsets.py). Patient sessions carry no meta
and never reach this module.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from fastapi.responses import Response, StreamingResponse

import agent_events
import lang as langmod
import llm_proxy
from llm_provider import chat, strip_think

log = logging.getLogger("medsim.agent_runtime")

STEP_TIMEOUT_S = 8.0
MAX_TOOL_CALLS_PER_ROUND = 4
MAX_CTX_BYTES = 12000
MAX_SESSIONS = 300

Executor = Callable[[str, dict[str, Any], dict[str, Any]], Awaitable[dict[str, Any]]]

DEFAULT_FALLBACK = {
    "en": "Sorry, I could not finish that just now. Could you say it again?",
    "hi": "माफ़ कीजिए, अभी यह पूरा नहीं हो पाया। क्या आप फिर से कह सकते हैं?",
}


@dataclass
class AgentToolset:
    kind: str
    tools: list[dict[str, Any]] = field(default_factory=list)
    executor: Optional[Executor] = None
    fillers: dict[str, dict[str, str]] = field(default_factory=dict)  # tool -> lang -> line
    system_addendum: str | Callable[[dict[str, Any]], str] = ""
    max_rounds: int = 2
    fallback: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_FALLBACK))
    # Tools whose repeat (same dedupe key) in one session returns the first result.
    idempotent: dict[str, Callable[[dict[str, Any]], str]] = field(default_factory=dict)
    # Allowed top-level ctx keys (anything else the client sends is dropped).
    ctx_keys: tuple[str, ...] = ()
    summarize: Optional[Callable[[str, dict[str, Any]], str]] = None
    # Custom turn handler (followup keeps its own, already-tested loop).
    handler: Optional[Callable[[dict[str, Any], dict[str, Any], str], Awaitable[Response]]] = None

    def tool_names(self) -> list[str]:
        return [t["function"]["name"] for t in self.tools]


_registry: dict[str, AgentToolset] = {}
_loaded = False
# session id (channel, else token hash) -> mutable per-session state
_sessions: dict[str, dict[str, Any]] = {}
_bg: set[asyncio.Future] = set()


def register(ts: AgentToolset) -> AgentToolset:
    _registry[ts.kind] = ts
    return ts


def _ensure_loaded() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    import agent_toolsets  # noqa: F401  (registers receptionist / teacher / viva / followup)


def get(kind: Any) -> Optional[AgentToolset]:
    _ensure_loaded()
    return _registry.get(kind) if isinstance(kind, str) else None


def is_registered(kind: Any) -> bool:
    return get(kind) is not None


def kinds() -> list[str]:
    _ensure_loaded()
    return sorted(_registry)


# ---------------------------------------------------------------- ctx validation

def _clean_value(v: Any, depth: int = 0) -> Any:
    if depth > 4:
        return None
    if v is None or isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v if v == v and abs(v) < 1e12 else None  # drop NaN / huge
    if isinstance(v, str):
        return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", v)[:400]
    if isinstance(v, (list, tuple)):
        return [x for x in (_clean_value(i, depth + 1) for i in list(v)[:40]) if x is not None]
    if isinstance(v, dict):
        out = {}
        for k, val in list(v.items())[:40]:
            if not isinstance(k, str) or len(k) > 60:
                continue
            cv = _clean_value(val, depth + 1)
            if cv is not None:
                out[k] = cv
        return out
    return None


def clean_ctx(kind: str, raw: Any) -> dict[str, Any]:
    """Whitelisted, size-limited copy of the client's agentContext. Raises ValueError when too big."""
    ts = get(kind)
    if ts is None or not isinstance(raw, dict):
        return {}
    out = {k: _clean_value(raw[k]) for k in ts.ctx_keys if k in raw}
    out = {k: v for k, v in out.items() if v is not None}
    if len(json.dumps(out, ensure_ascii=False).encode()) > MAX_CTX_BYTES:
        raise ValueError(f"agentContext is larger than {MAX_CTX_BYTES} bytes")
    return out


# ---------------------------------------------------------------- session state

def session_id(meta: dict[str, Any]) -> str:
    return str(meta.get("channel") or meta.get("sid") or "anon")


def session_state(sid: str) -> dict[str, Any]:
    st = _sessions.get(sid)
    if st is None:
        st = {"done": {}, "actions": [], "data": {}}
        _sessions[sid] = st
        while len(_sessions) > MAX_SESSIONS:
            _sessions.pop(next(iter(_sessions)))
    return st


def reset() -> None:
    """Tests only."""
    _sessions.clear()


def tool_ctx(meta: dict[str, Any]) -> dict[str, Any]:
    sid = session_id(meta)
    ctx = meta.get("ctx") if isinstance(meta.get("ctx"), dict) else {}
    return {
        "kind": meta.get("kind"),
        "channel": str(meta.get("channel") or ""),
        "ctx": ctx,
        "lang": langmod.norm_lang(meta.get("lang") or ctx.get("lang")),
        "state": session_state(sid),
        "publish": lambda etype, data=None: agent_events.publish(str(meta.get("channel") or ""), etype, data),
    }


# ---------------------------------------------------------------- tool execution

def _clip(value: Any, n: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:n]


def _pick(table: dict[str, str], lang: str) -> str:
    return table.get(lang) or table.get("en") or DEFAULT_FALLBACK["en"]


async def run_tool(ts: AgentToolset, tctx: dict[str, Any], name: str, raw_args: Any) -> dict[str, Any]:
    if name not in ts.tool_names() or ts.executor is None:
        return {"ok": False, "error": f"unknown tool {name}"}
    try:
        args = raw_args if isinstance(raw_args, dict) else json.loads(raw_args or "{}")
        if not isinstance(args, dict):
            raise ValueError("arguments must be an object")
    except (ValueError, TypeError):
        return {"ok": False, "error": "malformed arguments"}
    st = tctx["state"]
    key = None
    if name in ts.idempotent:
        try:
            key = f"{name}:{ts.idempotent[name](args)}"
        except Exception:  # noqa: BLE001
            key = None
        if key and key in st["done"]:
            return {**st["done"][key], "alreadyDone": True}
    try:
        res = await asyncio.wait_for(ts.executor(name, args, tctx), timeout=STEP_TIMEOUT_S)
    except asyncio.TimeoutError:
        res = {"ok": False, "error": "timed out"}
    except Exception as e:  # noqa: BLE001
        log.warning("%s tool %s failed: %s", ts.kind, name, type(e).__name__)
        res = {"ok": False, "error": type(e).__name__}
    if not isinstance(res, dict):
        res = {"ok": False, "error": "bad tool result"}
    if key and res.get("ok"):
        st["done"][key] = dict(res)
    summary = ts.summarize(name, res) if ts.summarize else f"{name}: {'ok' if res.get('ok') else res.get('error') or 'failed'}"
    st["actions"].append({"tool": name, "ok": bool(res.get("ok")), "summary": summary, "at": int(time.time() * 1000)})
    del st["actions"][:-30]
    tctx["publish"]("tool", {"tool": name, "ok": bool(res.get("ok")), "summary": summary[:240]})
    return res


def _addendum(ts: AgentToolset, tctx: dict[str, Any]) -> str:
    a = ts.system_addendum
    try:
        return a(tctx) if callable(a) else a
    except Exception:  # noqa: BLE001
        return ""


def _actions_note(tctx: dict[str, Any]) -> Optional[dict[str, str]]:
    acts = [a for a in tctx["state"]["actions"] if a["ok"]][-8:]
    if not acts:
        return None
    return {"role": "system", "content": "Actions already taken in this session (do not repeat them unless asked again): "
            + "; ".join(a["summary"] for a in acts) + "."}


def _with_system(messages: list[dict[str, Any]], text: str) -> list[dict[str, Any]]:
    if not text:
        return messages
    i = 0
    while i < len(messages) and messages[i].get("role") in ("system", "developer"):
        i += 1
    return messages[:i] + [{"role": "system", "content": text}] + messages[i:]


async def _llm(ts: AgentToolset, messages: list[dict[str, Any]], payload: dict[str, Any],
               stick_to: Optional[str], use_tools: bool = True) -> tuple[dict[str, Any], str]:
    client = llm_proxy._client_factory()
    try:
        return await asyncio.wait_for(
            chat(messages, tools=ts.tools if use_tools else None, max_tokens=int(payload.get("max_tokens") or 300),
                 temperature=float(payload.get("temperature") or 0.5), client=client, stick_to=stick_to),
            timeout=STEP_TIMEOUT_S,
        )
    finally:
        await client.aclose()


async def run_turn(ts: AgentToolset, payload: dict[str, Any], meta: dict[str, Any], emit_filler=None) -> str:
    """One agent turn with tools. Returns the text to speak (never raises)."""
    tctx = tool_ctx(meta)
    lang = tctx["lang"]
    messages = _with_system(llm_proxy.sanitize_messages(payload.get("messages")), _addendum(ts, tctx))
    note = _actions_note(tctx)
    if note:
        messages.append(note)
    provider: Optional[str] = None
    filler_sent = False
    fallback = _pick(ts.fallback, lang)
    for _round in range(max(1, ts.max_rounds)):
        try:
            msg, provider = await _llm(ts, messages, payload, provider)
        except Exception as e:  # noqa: BLE001 - HTTPException (502/503), timeouts, bad bodies
            log.warning("%s LLM round failed: %s", ts.kind, type(e).__name__)
            return fallback
        calls = [c for c in (msg.get("tool_calls") or []) if isinstance(c, dict)][:MAX_TOOL_CALLS_PER_ROUND]
        text = strip_think(str(msg.get("content") or ""))
        if not calls:
            return re.sub(r"[*_`#]+", "", text).strip() or fallback
        names = [str((c.get("function") or {}).get("name") or "") for c in calls]
        if emit_filler and not filler_sent:
            line = next((ts.fillers[n].get(lang) or ts.fillers[n].get("en") for n in names if n in ts.fillers), None)
            if line:
                await emit_filler(line)
                filler_sent = True
        # Sequential: a status lookup and an email in one round must not race.
        results = [await run_tool(ts, tctx, n, (c.get("function") or {}).get("arguments")) for n, c in zip(names, calls)]
        messages.append({"role": "assistant", "content": text or None, "tool_calls": [
            {"id": c.get("id") or f"call_{i}", "type": "function",
             "function": {"name": n, "arguments": (c.get("function") or {}).get("arguments") or "{}"}}
            for i, (n, c) in enumerate(zip(names, calls))]})
        for i, (c, res) in enumerate(zip(calls, results)):
            messages.append({"role": "tool", "tool_call_id": c.get("id") or f"call_{i}",
                             "content": json.dumps(res, ensure_ascii=False)[:4000]})
    # Rounds used up while the model still wanted tools: one last plain answer.
    try:
        closing = messages + [{"role": "user", "content": "(Reply to me now in one or two short spoken sentences. No tools.)"}]
        msg, _ = await _llm(ts, closing, {**payload, "max_tokens": 120}, provider, use_tools=False)
        text = re.sub(r"[*_`#]+", "", strip_think(str(msg.get("content") or ""))).strip()
        if text and not msg.get("tool_calls"):
            return text
    except Exception as e:  # noqa: BLE001
        log.warning("%s closing LLM call failed: %s", ts.kind, type(e).__name__)
    return fallback


def sse_response(cid: str, model: str, work: Callable[[Callable[[str], Awaitable[None]]], Awaitable[str]]) -> StreamingResponse:
    """Stream filler lines as they come, then the final text, as OpenAI chunks ending in [DONE]."""

    async def gen():
        queue: asyncio.Queue = asyncio.Queue()

        async def filler(line: str) -> None:
            await queue.put(line + " ")

        async def runner() -> None:
            try:
                await queue.put(await work(filler))
            except Exception as e:  # noqa: BLE001
                log.warning("agent turn crashed: %s", type(e).__name__)
                await queue.put(DEFAULT_FALLBACK["en"])
            finally:
                await queue.put(None)

        # Held in _bg so tools finish even if Agora drops the stream mid-turn.
        task = asyncio.ensure_future(runner())
        _bg.add(task)
        task.add_done_callback(_bg.discard)
        yield llm_proxy.sse_chunk(cid, model, {"role": "assistant", "content": ""})
        while (piece := await queue.get()) is not None:
            if piece:
                yield llm_proxy.sse_chunk(cid, model, {"content": piece})
        yield llm_proxy.sse_chunk(cid, model, {}, "stop")
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


async def handle(payload: dict[str, Any], meta: dict[str, Any], model: str) -> Response:
    """Proxy entry point for every registered (tool-enabled) agent kind."""
    ts = get(meta.get("kind"))
    if ts is None:  # llm_proxy checks first; defensive
        return llm_proxy._err(400, "unknown agent kind", "invalid_request_error")
    if ts.handler is not None:
        return await ts.handler(payload, meta, model)
    cid = f"chatcmpl-{re.sub(r'[^a-z]', '', ts.kind)[:12]}-" + secrets.token_hex(6)
    if payload.get("stream", True) is False:
        return llm_proxy.completion_json(cid, model, await run_turn(ts, payload, meta))
    return sse_response(cid, model, lambda filler: run_turn(ts, payload, meta, filler))
