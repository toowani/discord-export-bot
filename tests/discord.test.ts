// Offline tests for the pure helpers (run with: npm test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALL_PERMISSIONS, COMMANDS, PERM, basePermissions, canRead, channelPermissions, commandSignature,
  aiText, chunkLines, isAuthorized, kstLabel, panelId, parsePanelId, parseBoundary, serializeMessage, snowflakeAt, snowflakeTime, transcriptLines,
  verifyInteraction,
} from '../src/discord.ts';

const READ = (PERM.VIEW_CHANNEL | PERM.READ_MESSAGE_HISTORY).toString();
const guild = {
  id: 'g', owner_id: 'owner',
  roles: [
    { id: 'g', name: '@everyone', permissions: READ },
    { id: 'r-export', name: '대화내보내기', permissions: '0' },
    { id: 'r-admin', name: 'admin', permissions: PERM.ADMINISTRATOR.toString() },
    { id: 'r-manager', name: 'manager', permissions: PERM.MANAGE_GUILD.toString() },
  ],
};

test('commands: two slash commands and two message menus, signatures ignore server fields', () => {
  assert.deepEqual(COMMANDS.map((c) => [c.name, c.type]), [['내보내기', 1], ['요약', 1], ['범위 시작 지정', 3], ['범위 끝 지정', 3]]);
  const [exportCommand, summaryCommand] = COMMANDS as any[];
  assert.deepEqual(exportCommand.options.map((o: any) => o.name), ['채널', '시작', '끝', '요약', '공개']);
  assert.deepEqual(summaryCommand.options.map((o: any) => o.name), ['채널', '시작', '끝', '공개']);
  assert.deepEqual(exportCommand.options[0].channel_types, [0, 5]);
  assert.ok(exportCommand.options.every((o: any) => !o.required));
  const remote = { ...exportCommand, id: '1', application_id: '2', version: '3', guild_id: 'g' };
  assert.equal(commandSignature(remote), commandSignature(exportCommand));
  assert.notEqual(commandSignature({ ...exportCommand, description: '다름' }), commandSignature(exportCommand));
  // Discord reports message commands with an empty description.
  assert.equal(commandSignature({ ...COMMANDS[2], description: '', id: '9' }), commandSignature(COMMANDS[2]));
});

test('panel button IDs round-trip and reject tampering', () => {
  const state = { action: 'b', isPublic: true, channelId: '1000000000000000001', start: '1566420491839733760', end: null };
  const id = panelId(state);
  assert.ok(id.length <= 100);
  assert.deepEqual(parsePanelId(id), state);
  assert.equal(parsePanelId(id.replace('|b|', '|x|')), null);
  assert.equal(parsePanelId(`${id}|extra`), null);
  assert.equal(parsePanelId('p|j|m|abc||'), null);
  assert.equal(kstLabel('1566420491839733760'), '2026-11-01 20:55');
});

test('authorization: admin, manage guild, owner or the export role', () => {
  const check = (user: string, roles: string[]) => isAuthorized(basePermissions(guild, user, roles), guild.roles, roles, '대화내보내기');
  assert.ok(check('u', ['r-admin']));
  assert.ok(check('u', ['r-manager']));
  assert.ok(check('owner', []));
  assert.ok(check('u', ['r-export']));
  assert.ok(!check('u', []));
  assert.equal(basePermissions(guild, 'u', ['r-admin']), ALL_PERMISSIONS);
});

test('channel overwrites deny and allow access in Discord order', () => {
  const base = basePermissions(guild, 'u', ['r-export']);
  const hidden = [{ id: 'g', type: 0 as const, allow: '0', deny: PERM.VIEW_CHANNEL.toString() }];
  assert.ok(canRead(channelPermissions(base, 'g', 'u', ['r-export'], [])));
  assert.ok(!canRead(channelPermissions(base, 'g', 'u', ['r-export'], hidden)));
  const roleAllow = [...hidden, { id: 'r-export', type: 0 as const, allow: PERM.VIEW_CHANNEL.toString(), deny: '0' }];
  assert.ok(canRead(channelPermissions(base, 'g', 'u', ['r-export'], roleAllow)));
  const memberDeny = [...roleAllow, { id: 'u', type: 1 as const, allow: '0', deny: PERM.READ_MESSAGE_HISTORY.toString() }];
  assert.ok(!canRead(channelPermissions(base, 'g', 'u', ['r-export'], memberDeny)));
  assert.ok(canRead(channelPermissions(basePermissions(guild, 'u', ['r-admin']), 'g', 'u', ['r-admin'], hidden)));
});

test('message serialization keeps Korean text and attachment URLs only', () => {
  const item = serializeMessage({
    id: '5', channel_id: 'c', timestamp: '2026-01-01T00:00:00+00:00', edited_timestamp: null,
    author: { id: '7', username: 'wani', global_name: '와니' }, content: '안녕하세요',
    attachments: [{ filename: 'a.png', url: 'https://cdn/a.png', size: 3, proxy_url: 'x' }],
    message_reference: { message_id: '4' },
    reactions: [{ emoji: { id: null, name: '👍' }, count: 2 }, { emoji: { id: '9', name: 'pog', animated: true }, count: 1 }],
  }, 'g');
  assert.match(JSON.stringify(item), /안녕하세요/);
  assert.equal(item.author.name, '와니');
  assert.deepEqual(item.attachments, [{ filename: 'a.png', url: 'https://cdn/a.png', size: 3 }]);
  assert.equal(item.reply_to, '4');
  assert.deepEqual(item.reactions.map((r: any) => r.emoji), ['👍', '<a:pog:9>']);
  assert.equal(item.url, 'https://discord.com/channels/g/c/5');
});

test('interaction signatures: valid, tampered, stale', async () => {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const hex = (b: ArrayBuffer) => Buffer.from(b).toString('hex');
  const publicKey = hex(await crypto.subtle.exportKey('raw', keys.publicKey));
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"type":1}';
  const sig = hex(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, new TextEncoder().encode(ts + body)));
  assert.ok(await verifyInteraction(publicKey, sig, ts, body));
  assert.ok(!(await verifyInteraction(publicKey, sig, ts, '{"type":2}')));
  assert.ok(!(await verifyInteraction(publicKey, sig, ts, body, Date.now() + 10 * 60 * 1000)));
  assert.ok(!(await verifyInteraction(publicKey, null, ts, body)));
});

test('range boundaries: KST dates, times, message links and IDs', () => {
  const kst = (iso: string) => Date.parse(`${iso}+09:00`);
  const start = parseBoundary('2026-11-01', 'start')!;
  assert.equal(snowflakeTime(start.toString()), kst('2026-11-01T00:00:00'));
  const end = parseBoundary('2026-11-01', 'end')!;
  assert.equal(snowflakeTime(end.toString()), kst('2026-11-01T23:59:59.999'));
  assert.equal(end + 1n, snowflakeAt(kst('2026-11-02T00:00:00')));
  const minute = parseBoundary('2026-11-01 14:30', 'end')!;
  assert.equal(snowflakeTime(minute.toString()), kst('2026-11-01T14:30:59.999'));
  assert.equal(parseBoundary('https://discord.com/channels/1/2/1566420491839733760', 'start'), 1566420491839733760n);
  assert.equal(parseBoundary('https://ptb.discordapp.com/channels/1/2/1566420491839733760/', 'end'), 1566420491839733760n);
  assert.equal(parseBoundary(' 1566420491839733760 ', 'end'), 1566420491839733760n);
  for (const bad of ['2026-02-30', '2026-11-01 25:00', 'yesterday', 'https://example.com/channels/1/2/3', '12']) {
    assert.equal(parseBoundary(bad, 'start'), null, bad);
  }
  assert.equal(parseBoundary('2010-01-01', 'start'), 0n);
  assert.equal(parseBoundary('2010-01-01', 'end'), null);
});

test('summary transcript uses KST times, trims long messages and chunks by line', () => {
  const lines = transcriptLines([
    { timestamp: '2026-11-01T05:30:00+00:00', author: { name: '와니' }, content: '회의\n3시로', attachments: [{}] },
    { timestamp: '2026-11-01T15:00:00+00:00', author: { name: '민수' }, content: '가'.repeat(1500), attachments: [] },
  ]);
  assert.equal(lines[0], '[11-01 14:30] 와니: 회의 3시로 (첨부 1개)');
  assert.ok(lines[1].startsWith('[11-02 00:00] 민수: ') && lines[1].endsWith('…'));
  assert.equal(lines[1].length, '[11-02 00:00] 민수: '.length + 1001);
  const chunks = chunkLines(['a'.repeat(6), 'b'.repeat(6), 'c'.repeat(3)], 10);
  assert.deepEqual(chunks, ['aaaaaa', 'bbbbbb\nccc']);
  assert.ok(chunkLines(['x'.repeat(25)], 10).every((c) => c.length <= 10));
});

test('AI answer text comes from content, response or reasoning without think blocks', () => {
  assert.equal(aiText({ choices: [{ message: { content: '\n\n- 요약' } }] }), '- 요약');
  assert.equal(aiText({ response: '<think>생각</think>결과' }), '결과');
  assert.equal(aiText({ choices: [{ message: { content: null, reasoning: '대체' } }] }), '대체');
  assert.equal(aiText({}), '');
});
