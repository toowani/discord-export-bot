// Offline tests for the pure helpers (run with: npm test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALL_PERMISSIONS, COMMAND, PERM, basePermissions, canRead, channelPermissions, commandSignature,
  isAuthorized, serializeMessage, verifyInteraction,
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

test('command is a guild text-channel option and signature ignores server fields', () => {
  assert.equal(COMMAND.name, '내보내기');
  assert.deepEqual(COMMAND.options[0].channel_types, [0, 5]);
  assert.equal(COMMAND.options[0].required, false);
  const remote = { ...COMMAND, id: '1', application_id: '2', version: '3', guild_id: 'g' };
  assert.equal(commandSignature(remote), commandSignature(COMMAND));
  assert.notEqual(commandSignature({ ...COMMAND, description: '다름' }), commandSignature(COMMAND));
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
