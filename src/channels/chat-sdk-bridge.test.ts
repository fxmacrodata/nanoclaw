import http from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import type { InboundMessage } from './adapter.js';
import { createChatSdkBridge, detectSystemMessage, isThreadRootMessage, splitForLimit } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });

  it('reports an adapter transport probe when one is available', () => {
    let connected = false;
    const adapter = stubAdapter({}) as Adapter & { isConnected(): boolean };
    adapter.isConnected = () => connected;
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });

    expect(bridge.isConnected()).toBe(false);
    connected = true;
    expect(bridge.isConnected()).toBe(true);
  });

  it('keeps adapters without a transport probe available after setup', () => {
    const bridge = createChatSdkBridge({ adapter: stubAdapter({}), supportsThreads: true });
    expect(bridge.isConnected()).toBe(true);
  });
});

describe('createChatSdkBridge — instance identity', () => {
  it('default: name === channelType === adapter.name, instance undefined', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBeUndefined();
  });

  it('named instance: name follows the instance, channelType stays the platform', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack-tester');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBe('slack-tester');
  });

  it('rejects instance names that would break the webhook route or state delimiter', () => {
    for (const bad of ['a/b', 'a:b', 'a?b', 'a b']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });

  it('rejects empty and whitespace-only instance names (config bug — fail loud)', () => {
    // '' is falsy: a truthiness guard would skip it, dead-ending the
    // webhook route ('/webhook/' + '') and collapsing the state namespace
    // into the default instance's unprefixed keyspace — the exact
    // cross-bot dedupe/lock collisions the namespace exists to prevent.
    for (const bad of ['', ' ', '   ', '\t']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });
});

describe('createChatSdkBridge.setup — webhook route and state namespace', () => {
  // Real setup() over a stub adapter: Chat.initialize() needs a working
  // StateAdapter (chat_sdk_* tables) and an adapter.initialize — nothing
  // platform-side. registerWebhookAdapter is mocked at module level so we
  // can assert the (chat, adapterName, routingPath) triple.
  // runtimeMode is assigned inside initialize(), as the Telegram adapter does
  // when mode 'auto' resolves: a guard that reads it earlier sees undefined.
  function setupStubAdapter(runtimeMode?: 'webhook' | 'polling'): Adapter {
    const adapter = stubAdapter({ name: 'slack' }) as Adapter & { runtimeMode?: string };
    adapter.initialize = async () => {
      adapter.runtimeMode = runtimeMode;
    };
    return adapter;
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    vi.mocked(registerWebhookAdapter).mockClear();
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  const hostConfig = {
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };

  it('named instance registers the webhook with adapterName as handler key and instance as route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath).toBe('slack-tester');
    await bridge.teardown();
  });

  it('default instance registers the historical route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await bridge.setup(hostConfig);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath ?? adapterName).toBe('slack');
    await bridge.teardown();
  });

  // Polling adapters (Telegram) pull updates themselves; a registered route
  // would lazily bind the shared webhook port, and a busy port then crashes a
  // Telegram-only host. Kill condition: delete the `runtimeMode === 'polling'`
  // branch in setup() and the polling case goes red.
  it('polling adapter (mode resolved inside initialize) registers no webhook route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter('polling'), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).not.toHaveBeenCalled();
    await bridge.teardown();
  });

  it('webhook adapter registers the route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter('webhook'), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });

  it('adapter without runtimeMode registers the route (non-Telegram adapters declare none)', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });

  it('named instance namespaces Chat SDK state; default stays unprefixed (live-install constraint)', async () => {
    const { getDb } = await import('../db/connection.js');

    const named = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await named.setup(hostConfig);
    await named.subscribe!('slack:C1', 'slack:T1');

    const def = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await def.setup(hostConfig);
    await def.subscribe!('slack:C1', 'slack:T1');

    const rows = await getDb().all<{ thread_id: string }>(
      'SELECT thread_id FROM chat_sdk_subscriptions ORDER BY thread_id',
    );
    expect(rows.map((r) => r.thread_id)).toEqual(['slack-tester:slack:T1', 'slack:T1']);

    await named.teardown();
    await def.teardown();
  });

  it('explicitly naming the primary instance after the platform stays on the unprefixed keyspace', async () => {
    const { getDb } = await import('../db/connection.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack', // explicit, but equal to adapter.name ⇒ default keyspace
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    await bridge.subscribe!('slack:C1', 'slack:T9');
    const rows = await getDb().all<{ thread_id: string }>('SELECT thread_id FROM chat_sdk_subscriptions');
    expect(rows.map((r) => r.thread_id)).toEqual(['slack:T9']);
    await bridge.teardown();
  });
});

describe('isThreadRootMessage', () => {
  it('is true when the thread id ends in the message id', () => {
    expect(isThreadRootMessage('slack:C1:1724264405.531769', '1724264405.531769')).toBe(true);
  });

  it('is false for a reply inside an existing thread', () => {
    expect(isThreadRootMessage('slack:C1:1724264405.531769', '1724264999.000100')).toBe(false);
  });

  it('is false for an empty thread segment or empty message id', () => {
    expect(isThreadRootMessage('slack:C1:', '')).toBe(false);
    expect(isThreadRootMessage('slack:C1:', '1724264405.531769')).toBe(false);
  });

  it('defers to the configured override', () => {
    expect(isThreadRootMessage('chan:C1', 'm1', () => true)).toBe(true);
    expect(isThreadRootMessage('chan:C1:m1', 'm1', () => false)).toBe(false);
  });
});

describe('detectSystemMessage', () => {
  it('is undefined without a raw message', () => {
    expect(detectSystemMessage(undefined)).toBeUndefined();
  });

  it('flags a raw subtype that is not a user message', () => {
    expect(detectSystemMessage({ subtype: 'pinned_item' })).toBe(true);
    expect(detectSystemMessage({ subtype: 'reminder_add' })).toBe(true);
  });

  it('does not flag a plain message or a user-written subtype', () => {
    expect(detectSystemMessage({ text: 'hi' })).toBe(false);
    expect(detectSystemMessage({ subtype: 'file_share' })).toBe(false);
    expect(detectSystemMessage({ subtype: 'thread_broadcast' })).toBe(false);
  });

  it('defers to the configured override', () => {
    expect(detectSystemMessage({ type: 'system_join' }, (raw) => raw.type === 'system_join')).toBe(true);
    expect(detectSystemMessage({ subtype: 'pinned_item' }, () => false)).toBe(false);
  });
});

describe('createChatSdkBridge — inbound author and thread signals', () => {
  interface ChatDriver {
    processMessage(adapter: Adapter, threadId: string, message: unknown): Promise<void>;
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  interface MessageOpts {
    isBot?: boolean | 'unknown';
    raw?: Record<string, unknown>;
  }

  function makeMessage(id: string, opts: MessageOpts = {}): Record<string, unknown> {
    const author = { userId: 'U1', userName: 'h', isBot: opts.isBot ?? false, isMe: false };
    const payload = { id, text: 'hello', author };
    return {
      ...payload,
      attachments: [],
      isMention: false,
      metadata: { dateSent: new Date('2026-01-01T00:00:00.000Z') },
      raw: opts.raw,
      toJSON: () => ({ ...payload }),
    };
  }

  async function inbound(
    threadId: string,
    messageId: string,
    isThreadRoot?: (t: string, m: string) => boolean,
    opts: MessageOpts & { isDM?: boolean } = {},
  ) {
    let chat: ChatDriver | null = null;
    const adapter = stubAdapter({
      name: 'slack',
      initialize: async (c: unknown) => {
        chat = c as ChatDriver;
      },
      channelIdFromThreadId: (t: string) => t.split(':').slice(0, 2).join(':'),
      isDM: () => opts.isDM === true,
    } as Partial<Adapter>);
    const received: InboundMessage[] = [];
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true, isThreadRoot });
    await bridge.setup({
      onInbound: (_p, _t, message) => {
        received.push(message);
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    });
    await chat!.processMessage(adapter, threadId, makeMessage(messageId, opts));
    await bridge.teardown();
    return received[0];
  }

  it('flags a top-level message as a thread root and a reply as not', async () => {
    expect((await inbound('slack:C1:1700000000.000100', '1700000000.000100')).isThreadRoot).toBe(true);
    expect((await inbound('slack:C1:1700000000.000100', '1700000000.000200')).isThreadRoot).toBe(false);
  });

  it('uses the configured isThreadRoot override', async () => {
    expect((await inbound('slack:C1:1700000000.000100', '1700000000.000200', () => true)).isThreadRoot).toBe(true);
  });

  it('leaves isThreadRoot undefined on the DM path', async () => {
    const message = await inbound('slack:D1:1700000000.000100', '1700000000.000100', undefined, { isDM: true });
    expect(message.isThreadRoot).toBeUndefined();
  });

  // Distinct ids per call: the chat core dedupes on message id.
  const reply = (n: number, opts: MessageOpts) =>
    inbound('slack:C1:1700000000.000100', `1700000000.00020${n}`, undefined, opts);

  it("carries the author's bot flag, and leaves it undefined when the platform can't tell", async () => {
    expect((await reply(1, { isBot: false })).isBotAuthor).toBe(false);
    expect((await reply(2, { isBot: true })).isBotAuthor).toBe(true);
    expect((await reply(3, { isBot: 'unknown' })).isBotAuthor).toBeUndefined();
  });

  it('flags a system message from the raw event', async () => {
    expect((await reply(1, { raw: { subtype: 'pinned_item' } })).isSystemMessage).toBe(true);
    expect((await reply(2, { raw: { text: 'hello' } })).isSystemMessage).toBe(false);
  });
});

describe('createChatSdkBridge.deliver — ask_question cards (button styles)', () => {
  // Approval cards color their buttons (Slack: primary→green, danger→red).
  // The bridge must forward the normalized option style into Button() and
  // omit it when unset — an invalid style surviving to Block Kit would fail
  // the whole card with invalid_blocks (effective auto-deny).

  interface CapturedButton {
    type?: string;
    id?: string;
    label?: string;
    value?: string;
    style?: string;
  }

  function buttonsFrom(calls: PostCall[]): CapturedButton[] {
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: CapturedButton[] }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    return actionsRow?.children ?? [];
  }

  it('passes each option style through to the Button, and omits it when unset', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-1',
        title: 'Approval needed',
        question: 'Allow the tool call?',
        options: [
          { label: 'Approve', style: 'primary' },
          { label: 'Deny', style: 'danger' },
          'Skip', // string shorthand — never styled
        ],
      },
    });
    expect(calls).toHaveLength(1);
    const buttons = buttonsFrom(calls);
    expect(buttons.map((b) => b.label)).toEqual(['Approve', 'Deny', 'Skip']);
    expect(buttons.map((b) => b.style)).toEqual(['primary', 'danger', undefined]);
  });

  it('drops invalid styles before they reach the Button (delivery goes through normalizeOptions)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-2',
        title: 'Approval needed',
        question: 'Allow the tool call?',
        options: [{ label: 'Approve', style: 'chartreuse' }],
      },
    });
    const buttons = buttonsFrom(calls);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].style).toBeUndefined();
  });

  it('retains the approval body and replaces buttons with a muted timeout resolution', async () => {
    const edits: PostCall[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        editMessage: async (threadId, _messageId, message) => {
          edits.push({ threadId, message });
          return { id: 'msg-1', threadId, raw: {} };
        },
      }),
      supportsThreads: false,
    });

    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'msg-1',
        text: 'Credentials Request\n\n*Agent:* Andy\n*Action:* Send email\n\n⏱️ Timed out — no response',
        terminalCard: {
          title: 'Credentials Request',
          question: '*Agent:* Andy\n*Action:* Send email',
          resolution: '⏱️ Timed out — no response',
        },
      },
    });

    expect(edits).toHaveLength(1);
    const edited = edits[0].message as {
      card: { title: string; children: Array<{ type: string; content?: string; style?: string }> };
    };
    expect(edited.card.title).toBe('Credentials Request');
    expect(edited.card.children).toEqual([
      { type: 'text', content: '*Agent:* Andy\n*Action:* Send email' },
      { type: 'text', content: '⏱️ Timed out — no response', style: 'muted' },
    ]);
    expect(edited.card.children.some((child) => child.type === 'actions')).toBe(false);
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('survives a null action instead of throwing on a property read', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [null, { label: 'Open', url: 'https://example.com' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const buttons = msg.card?.children?.find((c) => c.type === 'actions')?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('renders an unknown style as the default button style rather than dropping the action', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [
            { label: 'Open', url: 'https://example.com', style: 'chartreuse' },
            { label: 'Also', url: 'https://example.org', style: null },
          ],
        },
      },
    });
    const msg = calls[0].message as {
      card?: {
        children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string; style?: string }> }>;
      };
    };
    const buttons = msg.card?.children?.find((c) => c.type === 'actions')?.children ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].style).toBeUndefined();
    expect(buttons[1].style).toBeUndefined();
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});

it('uses a registered approval presentation losslessly for initial and terminal cards', async () => {
  const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
  const evidence = 'full evidence\n'.repeat(500);
  registerQuestionRenderResolver((id) =>
    id === 'presentation-fixture'
      ? {
          title: 'Review',
          options: [],
          deferResolution: true,
          renderMessage: () => ({ markdown: evidence }),
          renderTerminal: (resolution) => ({ markdown: `${evidence}\n${resolution}` }),
        }
      : undefined,
  );
  const { calls, postMessage } = makePostCapture();
  const edits: PostCall[] = [];
  const bridge = createChatSdkBridge({
    adapter: stubAdapter({
      postMessage,
      editMessage: async (threadId, _id, message) => {
        edits.push({ threadId, message });
        return { id: 'card', threadId, raw: {} };
      },
    }),
    supportsThreads: false,
  });
  await bridge.deliver('stub:C1', null, {
    kind: 'chat-sdk',
    content: {
      type: 'ask_question',
      questionId: 'presentation-fixture',
      title: 'Review',
      options: [],
      requirePresentation: true,
    },
  });
  expect(calls[0].message).toEqual({ markdown: evidence });
  await bridge.deliver('stub:C1', null, {
    kind: 'chat-sdk',
    content: {
      operation: 'edit',
      questionId: 'presentation-fixture',
      messageId: 'card',
      terminalCard: { resolution: 'Rejected' },
    },
  });
  expect(edits[0].message).toEqual({ markdown: `${evidence}\nRejected` });
});

it('forwards the authenticated instance and message address without editing a deferred approval', async () => {
  const { initTestDb, closeDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
  await runMigrations(await initTestDb());
  registerQuestionRenderResolver((id) =>
    id === 'address-fixture'
      ? {
          title: 'Review',
          options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
          deferResolution: true,
        }
      : undefined,
  );
  const editMessage = vi.fn();
  const adapter = stubAdapter({
    name: 'fixture',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId,
    editMessage,
  });
  const bridge = createChatSdkBridge({ adapter, instance: 'fixture-one', supportsThreads: false });
  const onAction = vi.fn();
  try {
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const chat = (bridge as unknown as { _chat: import('chat').Chat })._chat;
    await chat.processAction(
      {
        actionId: 'ncq:address-fixture:0',
        adapter,
        messageId: 'original-card',
        raw: {},
        threadId: 'fixture:room',
        user: { userId: 'selected' } as never,
        value: '0',
      },
      undefined,
    );
    expect(onAction).toHaveBeenCalledWith('address-fixture', 'approve', 'selected', {
      instance: 'fixture-one',
      messageId: 'original-card',
      platformId: 'fixture:room',
    });
    expect(editMessage).not.toHaveBeenCalled();
  } finally {
    await bridge.teardown();
    await closeDb();
  }
});

describe('createChatSdkBridge — local Gateway webhook', () => {
  // The Gateway listener forwards raw events to a loopback server; only it may
  // post there. It sends the bot token in x-discord-gateway-token.
  const BOT_TOKEN = 'test-bot-token';
  const realFetch = globalThis.fetch;

  const click = JSON.stringify({
    type: 'GATEWAY_INTERACTION_CREATE',
    data: {
      type: 3,
      id: 'interaction-1',
      token: 'interaction-token',
      channel_id: 'chan-1',
      data: { custom_id: 'ncq:q-1:approve' },
      member: { user: { id: 'clicker-1', username: 'clicker' } },
      message: { id: 'card-1', embeds: [] },
    },
  });
  const message = JSON.stringify({ type: 'GATEWAY_MESSAGE_CREATE', data: { id: 'm-1', content: 'hi' } });

  async function startGateway(botToken?: string) {
    let webhookUrl = '';
    const handleWebhook = vi.fn(async () => new Response('ok'));
    const adapter = stubAdapter({
      name: 'discord',
      initialize: async () => {},
      handleWebhook,
      channelIdFromThreadId: (threadId: string) => threadId,
    }) as Adapter & { startGatewayListener: unknown };
    adapter.startGatewayListener = async (_opts: unknown, _ms: number, _signal: AbortSignal, url: string) => {
      webhookUrl = url;
      return new Response('{}');
    };
    const onAction = vi.fn();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true, botToken });
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const post = (body: string, headers: Record<string, string> = {}) =>
      realFetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    return { bridge, post, onAction, handleWebhook, webhookUrl };
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
    // Interaction acks go to the Discord API; keep them off the network.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  it.each([
    ['no gateway token', {}],
    ['a wrong gateway token', { 'x-discord-gateway-token': 'not-the-token' }],
  ])('rejects a request with %s before it reaches the adapter or the host', async (_label, headers) => {
    const { bridge, post, onAction, handleWebhook } = await startGateway(BOT_TOKEN);
    try {
      for (const body of [click, message]) {
        const res = await post(body, headers);
        expect(res.status).toBe(401);
      }
      expect(onAction).not.toHaveBeenCalled();
      expect(handleWebhook).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('answers 401 without waiting for the request body', async () => {
    const { bridge, webhookUrl } = await startGateway(BOT_TOKEN);
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = http.request(webhookUrl, { method: 'POST', headers: { 'Content-Length': '1000' } }, (res) => {
          resolve(res.statusCode);
          req.destroy();
        });
        req.on('error', reject);
        req.flushHeaders(); // the body never follows
      });
      expect(status).toBe(401);
    } finally {
      await bridge.teardown();
    }
  });

  it('rejects every request when no bot token is configured', async () => {
    const { bridge, post, onAction, handleWebhook } = await startGateway(undefined);
    try {
      const res = await post(click, { 'x-discord-gateway-token': '' });
      expect(res.status).toBe(401);
      expect((await post(message)).status).toBe(401);
      expect(onAction).not.toHaveBeenCalled();
      expect(handleWebhook).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('dispatches clicks and forwards other events when the gateway token matches', async () => {
    const { bridge, post, onAction, handleWebhook } = await startGateway(BOT_TOKEN);
    try {
      const auth = { 'x-discord-gateway-token': BOT_TOKEN };
      expect((await post(click, auth)).status).toBe(200);
      expect(onAction).toHaveBeenCalledWith('q-1', 'approve', 'clicker-1', {
        messageId: 'card-1',
        platformId: 'chan-1',
      });
      expect((await post(message, auth)).status).toBe(200);
      expect(handleWebhook).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.teardown();
    }
  });
});
