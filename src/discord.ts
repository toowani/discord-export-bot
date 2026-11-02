// Pure Discord helpers shared by the Worker and the export Durable Object (no Workers-only APIs).
export const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_MESSAGES = 25_000;
export const EXPORT_TIMEOUT_MS = 12 * 60 * 1000;
// Interaction tokens expire after 15 minutes; a job older than this can no longer reply.
export const JOB_STALE_MS = 15 * 60 * 1000;

export const PERM = {
  ADMINISTRATOR: 1n << 3n,
  MANAGE_GUILD: 1n << 5n,
  VIEW_CHANNEL: 1n << 10n,
  READ_MESSAGE_HISTORY: 1n << 16n,
};
export const ALL_PERMISSIONS = (1n << 64n) - 1n;

export const CHANNEL = { TEXT: 0, ANNOUNCEMENT: 5, PUBLIC_THREAD: 11, PRIVATE_THREAD: 12 };
export const EXPORTABLE_TYPES = [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT];

export const COMMAND = {
  name: '내보내기',
  type: 1,
  description: '채널과 접근 가능한 공개 스레드를 JSON으로 내보냅니다.',
  contexts: [0],
  options: [
    {
      type: 7,
      name: '채널',
      description: '내보낼 텍스트 채널 (생략하면 현재 채널)',
      required: false,
      channel_types: EXPORTABLE_TYPES,
    },
    {
      type: 3,
      name: '시작',
      description: '이 시점부터 (예: 2026-11-01, 2026-11-01 14:30 한국 시간, 메시지 링크·ID)',
      required: false,
      max_length: 200,
    },
    {
      type: 3,
      name: '끝',
      description: '이 시점까지 (날짜만 쓰면 그날 끝까지 포함)',
      required: false,
      max_length: 200,
    },
  ],
};

export type Role = { id: string; name: string; permissions: string };
export type Overwrite = { id: string; type: 0 | 1; allow: string; deny: string };

/** Fields that decide whether a registered command already matches ours. */
export function commandSignature(c: any) {
  return JSON.stringify({
    name: c.name,
    type: c.type ?? 1,
    description: c.description,
    options: (c.options ?? []).map((o: any) => ({
      name: o.name,
      type: o.type,
      description: o.description,
      required: Boolean(o.required),
      channel_types: [...(o.channel_types ?? [])].sort(),
    })),
  });
}

export function canRead(permissions: bigint): boolean {
  if (permissions & PERM.ADMINISTRATOR) return true;
  const need = PERM.VIEW_CHANNEL | PERM.READ_MESSAGE_HISTORY;
  return (permissions & need) === need;
}

/** Guild-level permissions from roles (Discord's documented base-permission algorithm). */
export function basePermissions(guild: { id: string; owner_id: string; roles: Role[] }, userId: string, roleIds: string[]): bigint {
  if (guild.owner_id === userId) return ALL_PERMISSIONS;
  const byId = new Map(guild.roles.map((r) => [r.id, r]));
  let perms = BigInt(byId.get(guild.id)?.permissions ?? '0');
  for (const id of roleIds) perms |= BigInt(byId.get(id)?.permissions ?? '0');
  return perms & PERM.ADMINISTRATOR ? ALL_PERMISSIONS : perms;
}

/** Applies channel overwrites on top of base permissions. */
export function channelPermissions(base: bigint, guildId: string, userId: string, roleIds: string[], overwrites: Overwrite[]): bigint {
  if (base & PERM.ADMINISTRATOR) return ALL_PERMISSIONS;
  let perms = base;
  const everyone = overwrites.find((o) => o.id === guildId);
  if (everyone) perms = (perms & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && roleIds.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  perms = (perms & ~deny) | allow;
  const member = overwrites.find((o) => o.type === 1 && o.id === userId);
  if (member) perms = (perms & ~BigInt(member.deny)) | BigInt(member.allow);
  return perms;
}

export function isAuthorized(base: bigint, roles: Role[], roleIds: string[], roleName: string): boolean {
  if (base & (PERM.ADMINISTRATOR | PERM.MANAGE_GUILD)) return true;
  return roles.some((r) => r.name === roleName && roleIds.includes(r.id));
}

function emojiString(e: { id?: string | null; name?: string | null; animated?: boolean }): string {
  return e.id ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : (e.name ?? '');
}

/** Same JSON shape as the original Python exporter; attachments are URLs only. */
export function serializeMessage(m: any, guildId: string) {
  return {
    id: m.id,
    timestamp: m.timestamp,
    edited_at: m.edited_timestamp ?? null,
    author: { id: m.author.id, name: m.author.global_name ?? m.author.username },
    content: m.content,
    attachments: (m.attachments ?? []).map((a: any) => ({ filename: a.filename, url: a.url, size: a.size })),
    reply_to: m.message_reference?.message_id ?? null,
    reactions: (m.reactions ?? []).map((r: any) => ({ emoji: emojiString(r.emoji), count: r.count })),
    url: `https://discord.com/channels/${guildId}/${m.channel_id}/${m.id}`,
  };
}

export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Verifies Discord's Ed25519 request signature and rejects stale timestamps (replay protection). */
export async function verifyInteraction(
  publicKeyHex: string, signatureHex: string | null, timestamp: string | null, body: string, nowMs = Date.now(),
): Promise<boolean> {
  if (!signatureHex || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, hexToBytes(signatureHex), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

const DISCORD_EPOCH = 1420070400000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Smallest snowflake that can be created at the given Unix time. */
export function snowflakeAt(ms: number): bigint {
  return BigInt(Math.max(0, ms - DISCORD_EPOCH)) << 22n;
}

export function snowflakeTime(id: string): number {
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
}

/**
 * Parses an export range boundary into an inclusive snowflake bound.
 * Accepts a message link, a message ID, or a KST date / date-time. Returns null when unreadable.
 */
export function parseBoundary(input: string, edge: 'start' | 'end'): bigint | null {
  const text = input.trim();
  const link = text.match(/^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/\d+\/\d+\/(\d{15,21})\/?$/);
  if (link) return BigInt(link[1]);
  if (/^\d{15,21}$/.test(text)) return BigInt(text);
  const m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hasTime = m[4] !== undefined;
  const [h, mi] = hasTime ? [Number(m[4]), Number(m[5])] : [0, 0];
  const local = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(local);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d
      || check.getUTCHours() !== h || check.getUTCMinutes() !== mi) return null;
  const ms = local - KST_OFFSET_MS;
  if (edge === 'start') return snowflakeAt(ms);
  // A bare date includes that whole day; a time includes that whole minute.
  const endExclusive = ms + (hasTime ? 60_000 : 24 * 60 * 60 * 1000);
  return endExclusive <= DISCORD_EPOCH ? null : snowflakeAt(endExclusive) - 1n;
}
