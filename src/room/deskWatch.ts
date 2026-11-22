// Questions left at Priya's desk: follow each side room until its answer comes,
// wherever the student is by then. At the desk Priya says it; anywhere else it
// is a notice (the same toasts faculty messages use). Survives a reload.

import { useSyncExternalStore } from 'react';
import { pushObserverMessage } from '../observer/studentLink';
import type { StudyPlan } from './academicCore';
import { deskNews, type DeskItem, type DeskNews } from './deskCore';
import { watchSide, type SideSession } from './sideSession';
import type { SideState } from './types';

export type { DeskItem, DeskNews } from './deskCore';

const KEY = 'medsim:desk';
const MAX = 8;
const KEEP_MS = 24 * 3600 * 1000;
/** A further question within this time goes to the same room. */
const SAME_ROOM_MS = 2 * 3600 * 1000;
/** Each follow is one open connection, and a browser has six: at most two. */
const MAX_FOLLOW = 2;
const AFTER_ANSWER_MS = 3 * 60 * 1000;

let items: DeskItem[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const sessions = new Map<string, SideSession>();
let atDesk: ((n: DeskNews) => void) | null = null;

function load(): DeskItem[] {
  if (loaded) return items;
  loaded = true;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    const now = Date.now();
    items = Array.isArray(raw)
      ? (raw as DeskItem[]).filter((i) => i && typeof i.sideId === 'string' && Array.isArray(i.seen) && now - i.at < KEEP_MS).slice(0, MAX)
      : [];
  } catch {
    items = [];
  }
  return items;
}

function save(next: DeskItem[]): void {
  items = next.slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* this page still follows it */
  }
  for (const l of listeners) l();
}

const patch = (sideId: string, p: Partial<DeskItem>) => save(load().map((i) => (i.sideId === sideId ? { ...i, ...p } : i)));

function onState(sideId: string, side: SideState): void {
  const item = load().find((i) => i.sideId === sideId);
  if (!item) return;
  const { news, next } = deskNews(item, side);
  if (next !== item) patch(sideId, next);
  for (const n of news) {
    if (atDesk) atDesk(n);
    else pushObserverMessage(`desk:${sideId}:${n.id}`, 'Priya at Reception', n.shown);
  }
  if (next.done) unfollow(sideId);
  // Answered: listen a little longer for a second message, then free the connection.
  else if (news.length) setTimeout(() => unfollow(sideId), AFTER_ANSWER_MS);
}

function unfollow(sideId: string): void {
  sessions.get(sideId)?.stop();
  sessions.delete(sideId);
}

function follow(sideId: string): void {
  if (sessions.has(sideId)) return;
  while (sessions.size >= MAX_FOLLOW) unfollow(sessions.keys().next().value as string);
  sessions.set(
    sideId,
    watchSide(sideId, {
      onState: (s) => onState(sideId, s),
      onGone: () => {
        sessions.delete(sideId);
        patch(sideId, { done: true });
      },
      onDisabled: () => sessions.delete(sideId),
    }),
  );
}

/** A desk tool opened a room (typed reply or voice event). */
export function followDesk(raw: Record<string, unknown> | null | undefined): void {
  const sideId = typeof raw?.sideId === 'string' ? raw.sideId : '';
  if (!sideId) return;
  const kind = raw?.kind === 'desk_plan' ? 'desk_plan' : 'desk';
  const ready = raw?.ready === true;
  const old = load().find((i) => i.sideId === sideId);
  const item: DeskItem = {
    ...(old ?? { seen: [] }),
    sideId,
    kind,
    question: typeof raw?.question === 'string' ? raw.question : old?.question,
    at: Date.now(),
    done: false,
    // Priya has just said it herself.
    seen: ready ? [...(old?.seen ?? []), 'plan'] : old?.seen ?? [],
    plan: ready ? (raw?.plan as StudyPlan) : old?.plan,
  };
  save([item, ...load().filter((i) => i.sideId !== sideId)]);
  follow(sideId);
}

/** While the reception panel is open, Priya speaks the news herself. */
export function setDeskListener(fn: ((n: DeskNews) => void) | null): void {
  atDesk = fn;
}

/** Resume what was still open when the page was closed. */
export function startDeskWatch(): void {
  for (const i of load().filter((x) => !x.done && !x.answer).slice(0, MAX_FOLLOW)) follow(i.sideId);
}

/** The open question room a follow-up belongs to. */
export function openDeskRoom(): string | null {
  const i = load().find((x) => x.kind === 'desk' && !x.done && Date.now() - x.at < SAME_ROOM_MS);
  return i?.sideId ?? null;
}

export function useDeskItems(): DeskItem[] {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, load);
}
