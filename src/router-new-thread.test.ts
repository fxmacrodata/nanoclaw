/**
 * engage_mode 'new-thread': in a group chat the agent engages on every message
 * that starts a new thread, on mentions, and on follow-ups in threads it has
 * already engaged (per-thread session exists). Replies in other threads, DMs,
 * messages whose root signal is unknown, and bot or system messages never
 * engage without a mention.
 *
 * Exercised through the REAL routeInbound path (adapter registry + seeded
 * wiring), not by calling the dispatch directly.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-new-thread' };
});

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { getUnregisteredSenders } from './db/dropped-messages.js';
import { findSessionForAgent } from './db/sessions.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { routeInbound } from './router.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';
import type { EngageMode } from './types.js';
// Side-effect import: registers the access gate that enforces unknown_sender_policy.
import './modules/permissions/index.js';

const TEST_DIR = '/tmp/nanoclaw-test-new-thread';
const ROOT = 'testchat:C1:100';

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

const subscribe = vi.fn().mockResolvedValue(undefined);

function makeAdapter(): ChannelAdapter {
  return {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
    subscribe,
  };
}

async function activate(): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

async function seedWiring(
  isGroup: 0 | 1,
  opts: { engageMode?: EngageMode; engagePattern?: string; threads?: 0 | 1; policy?: 'public' | 'strict' } = {},
): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Test Chat',
    is_group: isGroup,
    unknown_sender_policy: opts.policy ?? 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: opts.engageMode ?? 'new-thread',
    engage_pattern: opts.engagePattern ?? null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    threads: opts.threads ?? 1,
    created_at: now(),
  });
}

async function inbound(
  id: string,
  threadId: string,
  opts: {
    isThreadRoot?: boolean;
    isMention?: boolean;
    isGroup?: boolean;
    isBotAuthor?: boolean;
    isSystemMessage?: boolean;
    text?: string;
  } = {},
): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Alex', senderId: 'U1', text: opts.text ?? 'hello' }),
      timestamp: now(),
      isMention: opts.isMention ?? false,
      isGroup: opts.isGroup ?? true,
      isThreadRoot: opts.isThreadRoot,
      // A human, plain message unless a test says otherwise.
      isBotAuthor: 'isBotAuthor' in opts ? opts.isBotAuthor : false,
      isSystemMessage: 'isSystemMessage' in opts ? opts.isSystemMessage : false,
    },
  });
}

async function engagedIn(threadId: string): Promise<boolean> {
  return (await findSessionForAgent('ag-1', 'mg-1', threadId)) !== undefined;
}

async function droppedCount(): Promise<number> {
  // One row per chat; message_count counts the drops.
  return (await getUnregisteredSenders())
    .filter((d) => d.reason === 'no_agent_engaged')
    .reduce((n, d) => n + d.message_count, 0);
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe("engage_mode 'new-thread'", () => {
  it('engages on a thread root in a group without a mention', async () => {
    await activate();
    await seedWiring(1);

    await inbound('100', ROOT, { isThreadRoot: true });

    expect(await engagedIn(ROOT)).toBe(true);
    expect(await droppedCount()).toBe(0);
  });

  it('does not engage on a reply in a thread with no session, and subscribes nothing', async () => {
    await activate();
    await seedWiring(1);

    await inbound('101', ROOT, { isThreadRoot: false });

    expect(await engagedIn(ROOT)).toBe(false);
    expect(await droppedCount()).toBe(1);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('engages on a reply in a thread that already has a session, without subscribing the thread', async () => {
    await activate();
    await seedWiring(1);

    await inbound('100', ROOT, { isThreadRoot: true });
    await inbound('101', ROOT, { isThreadRoot: false });

    expect(await droppedCount()).toBe(0);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('engages on a mention in a thread with no session', async () => {
    await activate();
    await seedWiring(1);

    await inbound('101', ROOT, { isThreadRoot: false, isMention: true });

    expect(await engagedIn(ROOT)).toBe(true);
    expect(await droppedCount()).toBe(0);
  });

  it('never engages in a DM, even on a root mention', async () => {
    await activate();
    await seedWiring(0);

    await inbound('100', ROOT, { isThreadRoot: true, isMention: true, isGroup: false });

    expect(await droppedCount()).toBe(1);
  });

  it('treats an undefined root signal as not a root', async () => {
    await activate();
    await seedWiring(1);

    await inbound('100', ROOT);

    expect(await engagedIn(ROOT)).toBe(false);
    expect(await droppedCount()).toBe(1);
  });

  it('does not engage on a root written by a bot', async () => {
    await activate();
    await seedWiring(1);

    await inbound('100', ROOT, { isThreadRoot: true, isBotAuthor: true });

    expect(await engagedIn(ROOT)).toBe(false);
    expect(await droppedCount()).toBe(1);
  });

  it('does not engage on a system-message root', async () => {
    await activate();
    await seedWiring(1);

    await inbound('100', ROOT, { isThreadRoot: true, isSystemMessage: true });

    expect(await engagedIn(ROOT)).toBe(false);
    expect(await droppedCount()).toBe(1);
  });

  it('does not engage on a root whose author or message type the adapter did not report', async () => {
    await activate();
    await seedWiring(1);

    await inbound('100', ROOT, { isThreadRoot: true, isBotAuthor: undefined });
    await inbound('200', 'testchat:C1:200', { isThreadRoot: true, isSystemMessage: undefined });

    expect(await engagedIn(ROOT)).toBe(false);
    expect(await engagedIn('testchat:C1:200')).toBe(false);
    expect(await droppedCount()).toBe(2);
  });

  it('does not engage on a bot or system follow-up in an engaged thread', async () => {
    await activate();
    await seedWiring(1);

    await inbound('100', ROOT, { isThreadRoot: true });
    await inbound('101', ROOT, { isThreadRoot: false, isBotAuthor: true });
    await inbound('102', ROOT, { isThreadRoot: false, isSystemMessage: true });

    expect(await droppedCount()).toBe(2);
  });

  it('engages on a follow-up whose author the adapter did not report', async () => {
    await activate();
    await seedWiring(1);

    await inbound('100', ROOT, { isThreadRoot: true });
    await inbound('101', ROOT, { isThreadRoot: false, isBotAuthor: undefined, isSystemMessage: undefined });

    expect(await droppedCount()).toBe(0);
  });

  it('does not engage on a root when the wiring has no thread id', async () => {
    await activate();
    await seedWiring(1, { threads: 0 });

    await inbound('100', ROOT, { isThreadRoot: true });

    expect(await findSessionForAgent('ag-1', 'mg-1', null)).toBeUndefined();
    expect(await droppedCount()).toBe(1);
  });

  it('creates no session for a root that the command gate filters', async () => {
    await activate();
    await seedWiring(1);

    await inbound('100', ROOT, { isThreadRoot: true, text: '/help' });
    await inbound('101', ROOT, { isThreadRoot: false });

    expect(await engagedIn(ROOT)).toBe(false);
    expect(await droppedCount()).toBe(1);
  });

  it('creates no session for a root from an unknown sender under the strict policy', async () => {
    await activate();
    await seedWiring(1, { policy: 'strict' });

    await inbound('100', ROOT, { isThreadRoot: true });

    expect(await engagedIn(ROOT)).toBe(false);
  });

  it.each([
    { engageMode: 'mention' as const },
    { engageMode: 'mention-sticky' as const },
    { engageMode: 'pattern' as const, engagePattern: 'never-matches' },
  ])('a root signal does not engage a $engageMode wiring', async (opts) => {
    await activate();
    await seedWiring(1, opts);

    await inbound('100', ROOT, { isThreadRoot: true });

    expect(await engagedIn(ROOT)).toBe(false);
    expect(await droppedCount()).toBe(1);
  });
});
