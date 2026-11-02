// Discord HTTP Interactions endpoint for /내보내기 on the Workers Free plan.
// The Worker answers within Discord's 3-second deadline; a single Durable Object collects
// messages in alarm-driven steps (Free plan: 50 subrequests per invocation) and replies privately.
import { DurableObject } from 'cloudflare:workers';
import {
  CHANNEL, COMMAND, EXPORTABLE_TYPES, EXPORT_TIMEOUT_MS, JOB_STALE_MS, MAX_BYTES, MAX_MESSAGES,
  basePermissions, canRead, channelPermissions, commandSignature, compareSnowflakes, isAuthorized,
  serializeMessage, verifyInteraction, type Role,
} from './discord.ts';

interface Env {
  EXPORTER: DurableObjectNamespace<ExportJob>;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_GUILD_ID: string;
  ADMIN_TOKEN?: string;
  ALLOWED_ROLE?: string;
  DISCORD_API?: string;
}

const EPHEMERAL = 64;
// Stay under the Free plan's 50 subrequests per invocation, leaving room for the final reply.
const CALLS_PER_STEP = 40;
const PAGE = 100;

type ThreadInfo = { id: string; name: string; archived: boolean };
type ThreadResult = ThreadInfo & { message_count: number; first: number; last: number };

type Job = {
  appId: string;
  token: string;
  guildId: string;
  userId: string;
  roleIds: string[];
  channelId: string;
  roleName: string;
  startedAt: number;
  phase: 'auth' | 'parent' | 'active' | 'archived' | 'thread' | 'deliver';
  guildName: string;
  channelName: string;
  cursor: string;
  pages: number;
  messages: number;
  bytes: number;
  parentPages: number;
  parentMessages: number;
  archivedBefore: string | null;
  queue: ThreadInfo[];
  threadIdx: number;
  threadFirst: number;
  threadCount: number;
  threadBytes: number;
  threads: ThreadResult[];
  warnings: string[];
  pauseUntil: number;
};

export type StartRequest = Pick<Job, 'appId' | 'token' | 'guildId' | 'userId' | 'roleIds' | 'channelId'>;

class Yield extends Error {}
class Wait extends Error {
  constructor(public ms: number) { super('rate limited'); }
}
class HttpError extends Error {
  constructor(public status: number) { super(`HTTP ${status}`); }
}
class Abort extends Error {
  constructor(public userMessage: string) { super('abort'); }
}

const api = (env: Env) => env.DISCORD_API ?? 'https://discord.com/api/v10';

export class ExportJob extends DurableObject<Env> {
  private calls = 0;
  private job!: Job;

  // One object for the whole guild, so this is also the "one export at a time" lock.
  async start(req: StartRequest): Promise<'accepted' | 'busy'> {
    const current = await this.ctx.storage.get<Job>('job');
    if (current && Date.now() - current.startedAt < JOB_STALE_MS) return 'busy';
    await this.ctx.storage.deleteAll();
    const job: Job = {
      ...req, roleName: this.env.ALLOWED_ROLE ?? '대화내보내기', startedAt: Date.now(), phase: 'auth',
      guildName: '', channelName: '', cursor: '0', pages: 0, messages: 0, bytes: 0, parentPages: 0, parentMessages: 0,
      archivedBefore: null, queue: [], threadIdx: 0, threadFirst: 0, threadCount: 0, threadBytes: 0, threads: [],
      warnings: [], pauseUntil: 0,
    };
    await this.ctx.storage.put('job', job);
    await this.ctx.storage.setAlarm(Date.now());
    console.log(JSON.stringify({ event: 'export_started' }));
    return 'accepted';
  }

  async status() {
    const job = await this.ctx.storage.get<Job>('job');
    return job
      ? { running: true, phase: job.phase, age_s: Math.round((Date.now() - job.startedAt) / 1000), messages: job.messages }
      : { running: false };
  }

  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<Job>('job');
    if (!job) return;
    this.job = job;
    this.calls = 0;
    try {
      while (true) {
        if (Date.now() - job.startedAt > EXPORT_TIMEOUT_MS) {
          throw new Abort('12분 작업 제한을 초과했어요. 파일을 전송하지 않았어요.');
        }
        if (await this.step()) break;
      }
      await this.finish('export_completed');
    } catch (error) {
      if (error instanceof Yield || error instanceof Wait) {
        await this.ctx.storage.put('job', job);
        await this.ctx.storage.setAlarm(Date.now() + (error instanceof Wait ? error.ms : 0));
        return;
      }
      const text = error instanceof Abort
        ? error.userMessage
        : '내보내기에 실패했어요. 채널 권한과 봇 상태를 확인해 주세요.';
      console.warn(JSON.stringify({ event: 'export_failed', phase: job.phase, error: error instanceof HttpError ? error.message : error instanceof Abort ? 'abort' : (error as Error)?.name }));
      await this.reply({ content: text }).catch(() => console.warn(JSON.stringify({ event: 'reply_failed' })));
      await this.finish('export_aborted');
    }
  }

  private async finish(event: string) {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    console.log(JSON.stringify({ event }));
  }

  /** Discord REST call with the bot token; counts subrequests and honours rate limits. */
  private async discord(path: string): Promise<any> {
    const now = Date.now();
    if (this.job.pauseUntil > now) throw new Wait(this.job.pauseUntil - now);
    if (this.calls >= CALLS_PER_STEP) throw new Yield();
    this.calls++;
    const res = await fetch(`${api(this.env)}${path}`, {
      headers: { Authorization: `Bot ${this.env.DISCORD_TOKEN}`, 'User-Agent': 'DiscordBot (discord-export-bot, 2.0)' },
    });
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      throw new Wait(Math.ceil((body.retry_after ?? 1) * 1000) + 100);
    }
    if (res.headers.get('X-RateLimit-Remaining') === '0') {
      this.job.pauseUntil = Date.now() + Math.ceil(Number(res.headers.get('X-RateLimit-Reset-After') ?? '1') * 1000);
    }
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  }

  /** Edits the deferred ephemeral response, so only the invoking user ever sees it. */
  private async reply(payload: Record<string, unknown>, file?: Uint8Array, filename?: string) {
    const url = `${api(this.env)}/webhooks/${this.job.appId}/${this.job.token}/messages/@original`;
    let init: RequestInit;
    if (file && filename) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ ...payload, attachments: [{ id: 0, filename }] }));
      form.append('files[0]', new Blob([file], { type: 'application/json' }), filename);
      init = { method: 'PATCH', body: form };
    } else {
      init = { method: 'PATCH', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } };
    }
    const res = await fetch(url, init);
    if (!res.ok) throw new HttpError(res.status);
  }

  /** Runs one unit of work; returns true when the export has been delivered. */
  private async step(): Promise<boolean> {
    const job = this.job;
    switch (job.phase) {
      case 'auth': {
        const guild = await this.discord(`/guilds/${job.guildId}`);
        const base = basePermissions(guild, job.userId, job.roleIds);
        if (!isAuthorized(base, guild.roles, job.roleIds, job.roleName)) {
          throw new Abort('서버 관리자 또는 대화내보내기 역할이 필요해요.');
        }
        const channel = await this.discord(`/channels/${job.channelId}`);
        if (!EXPORTABLE_TYPES.includes(channel.type) || channel.guild_id !== job.guildId) {
          throw new Abort('내보낼 텍스트 채널을 지정해 주세요.');
        }
        job.guildName = guild.name;
        job.channelName = channel.name;
        job.phase = 'parent';
        return false;
      }
      case 'parent': {
        let done: boolean;
        try {
          done = await this.collectPage(job.channelId);
        } catch (error) {
          if (error instanceof HttpError && error.status === 403) {
            throw new Abort('사용자와 봇 모두 채널 보기·메시지 기록 보기 권한이 필요해요.');
          }
          throw error;
        }
        if (done) {
          job.parentPages = job.pages;
          job.parentMessages = job.messages;
          job.phase = 'active';
        }
        return false;
      }
      case 'active': {
        try {
          const { threads } = await this.discord(`/guilds/${job.guildId}/threads/active`);
          for (const t of threads) {
            if (t.parent_id === job.channelId && t.type === CHANNEL.PUBLIC_THREAD) job.queue.push(threadInfo(t));
          }
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          job.warnings.push('활성 공개 스레드 목록 조회 실패');
        }
        job.phase = 'archived';
        return false;
      }
      case 'archived': {
        try {
          const before = job.archivedBefore ? `&before=${encodeURIComponent(job.archivedBefore)}` : '';
          const page = await this.discord(`/channels/${job.channelId}/threads/archived/public?limit=100${before}`);
          for (const t of page.threads) {
            if (t.type === CHANNEL.PUBLIC_THREAD) job.queue.push(threadInfo(t));
          }
          const last = page.threads.at(-1);
          if (page.has_more && last) {
            job.archivedBefore = last.thread_metadata.archive_timestamp;
            return false;
          }
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          job.warnings.push('보관된 공개 스레드 목록 조회 실패');
        }
        const unique = new Map(job.queue.map((t) => [t.id, t]));
        job.queue = [...unique.values()].sort((a, b) => compareSnowflakes(a.id, b.id));
        this.startThread();
        job.phase = 'thread';
        return false;
      }
      case 'thread': {
        const thread = job.queue[job.threadIdx];
        if (!thread) {
          job.phase = 'deliver';
          return false;
        }
        let done = false;
        try {
          done = await this.collectPage(thread.id);
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          job.warnings.push(`공개 스레드 ${thread.id} 수집 실패`);
          // Drop the partial thread from the totals; its stored pages are never read.
          job.messages -= job.threadCount;
          job.bytes -= job.threadBytes;
          job.threadIdx++;
          this.startThread();
          return false;
        }
        if (done) {
          job.threads.push({ ...thread, message_count: job.threadCount, first: job.threadFirst, last: job.pages });
          job.threadIdx++;
          this.startThread();
        }
        return false;
      }
      case 'deliver':
        await this.deliver();
        return true;
    }
  }

  private startThread() {
    this.job.cursor = '0';
    this.job.threadFirst = this.job.pages;
    this.job.threadCount = 0;
    this.job.threadBytes = 0;
  }

  /** Stores one page of up to 100 messages (oldest first); returns true at the end of the channel. */
  private async collectPage(channelId: string): Promise<boolean> {
    const job = this.job;
    const batch: any[] = await this.discord(`/channels/${channelId}/messages?limit=${PAGE}&after=${job.cursor}`);
    batch.sort((a, b) => compareSnowflakes(a.id, b.id));
    if (batch.length) {
      const encoder = new TextEncoder();
      const items = batch.map((m) => JSON.stringify(serializeMessage(m, job.guildId)));
      for (const item of items) {
        const size = encoder.encode(item).length + 1;
        job.bytes += size;
        job.threadBytes += size;
        job.messages++;
        if (job.bytes > MAX_BYTES || job.messages > MAX_MESSAGES) {
          throw new Abort('8MB 또는 25,000개 메시지 제한을 초과했어요. 파일을 전송하지 않았어요.');
        }
      }
      await this.ctx.storage.put(`p:${job.pages}`, items.join(','));
      job.pages++;
      job.threadCount += batch.length;
      job.cursor = batch.at(-1).id;
    }
    return batch.length < PAGE;
  }

  private async pages(first: number, last: number): Promise<string> {
    const keys = Array.from({ length: last - first }, (_, i) => `p:${first + i}`);
    const parts: string[] = [];
    // storage.get accepts at most 128 keys per call.
    for (let i = 0; i < keys.length; i += 128) {
      const got = await this.ctx.storage.get<string>(keys.slice(i, i + 128));
      for (const k of keys.slice(i, i + 128)) parts.push(got.get(k) ?? '');
    }
    return parts.filter(Boolean).join(',');
  }

  private async deliver() {
    const job = this.job;
    // Re-check access right before delivery, as the Gateway version did.
    const [member, guild, channel] = [
      await this.discord(`/guilds/${job.guildId}/members/${job.userId}`),
      await this.discord(`/guilds/${job.guildId}`),
      await this.discord(`/channels/${job.channelId}`),
    ];
    const base = basePermissions(guild, job.userId, member.roles);
    const perms = channelPermissions(base, job.guildId, job.userId, member.roles, channel.permission_overwrites ?? []);
    if (!isAuthorized(base, guild.roles as Role[], member.roles, job.roleName) || !canRead(perms)) {
      throw new Abort('내보내기 권한이 변경되어 파일을 전송하지 않았어요.');
    }

    const parent = await this.pages(0, job.parentPages);
    const threadParts: string[] = [];
    let threadMessages = 0;
    for (const t of job.threads) {
      threadMessages += t.message_count;
      const meta = JSON.stringify({ thread_id: t.id, thread_name: t.name, archived: t.archived, message_count: t.message_count });
      threadParts.push(`${meta.slice(0, -1)},"messages":[${await this.pages(t.first, t.last)}]}`);
    }
    const parentCount = job.parentMessages;
    const summary = {
      parent_messages: parentCount, threads: job.threads.length,
      thread_messages: threadMessages, total_messages: parentCount + threadMessages,
    };
    const head = JSON.stringify({
      guild_id: job.guildId, guild_name: job.guildName, channel_id: job.channelId, channel_name: job.channelName,
      exported_at: new Date().toISOString(), summary,
    });
    const json = `${head.slice(0, -1)},"parent_channel":{"messages":[${parent}]},"threads":[${threadParts.join(',')}],"warnings":${JSON.stringify(job.warnings)}}`;
    const bytes = new TextEncoder().encode(json);
    if (bytes.length > MAX_BYTES) {
      throw new Abort('8MB 또는 25,000개 메시지 제한을 초과했어요. 파일을 전송하지 않았어요.');
    }
    await this.reply({
      content: `내보내기 완료: 메시지 ${summary.total_messages}개, 공개 스레드 ${summary.threads}개.\n`
        + `수집 경고 ${job.warnings.length}건. 비공개 스레드 제외, 첨부파일은 URL만 포함합니다.`,
    }, bytes, `discord_${job.channelId}.json`);
  }
}

function threadInfo(t: any): ThreadInfo {
  return { id: t.id, name: t.name, archived: Boolean(t.thread_metadata?.archived) };
}

function ephemeral(content: string): Response {
  return Response.json({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
}

async function handleCommand(interaction: any, env: Env): Promise<Response> {
  const member = interaction.member;
  if (interaction.guild_id !== env.DISCORD_GUILD_ID || !member) {
    return ephemeral('서버 관리자 또는 대화내보내기 역할이 필요해요.');
  }
  const optionId = interaction.data.options?.find((o: any) => o.name === '채널')?.value;
  const resolved = optionId ? interaction.data.resolved?.channels?.[optionId] : null;
  let target = resolved ?? interaction.channel;
  // Resolved channels carry the invoker's permissions there; otherwise use the current channel's.
  const permissions = BigInt(resolved?.permissions ?? member.permissions ?? '0');
  if (!target) return ephemeral('내보낼 텍스트 채널을 지정해 주세요.');
  if (target.type === CHANNEL.PRIVATE_THREAD) return ephemeral('비공개 스레드에서는 실행할 수 없어요.');
  let channelId: string = target.id;
  if (target.type === CHANNEL.PUBLIC_THREAD) {
    channelId = target.parent_id;
  } else if (!EXPORTABLE_TYPES.includes(target.type)) {
    return ephemeral('내보낼 텍스트 채널을 지정해 주세요.');
  }
  // Public threads inherit the parent's overwrites, so the invoker's access carries over.
  if (!canRead(permissions)) return ephemeral('사용자와 봇 모두 채널 보기·메시지 기록 보기 권한이 필요해요.');

  const result = await env.EXPORTER.getByName(env.DISCORD_GUILD_ID).start({
    appId: interaction.application_id, token: interaction.token, guildId: interaction.guild_id,
    userId: member.user.id, roleIds: member.roles ?? [], channelId,
  });
  if (result === 'busy') return ephemeral('다른 내보내기가 진행 중이에요. 완료 후 다시 시도해 주세요.');
  return Response.json({ type: 5, data: { flags: EPHEMERAL } });
}

async function adminAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('Authorization') ?? '';
  if (!env.ADMIN_TOKEN || !header.startsWith('Bearer ')) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(header.slice(7))),
    crypto.subtle.digest('SHA-256', enc.encode(env.ADMIN_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);

/**
 * Points the app's Interactions Endpoint URL at this Worker and creates or updates only /내보내기;
 * other commands of this app are left untouched.
 */
async function setup(env: Env, origin: string): Promise<Response> {
  const headers = { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' };
  const appRes = await fetch(`${api(env)}/applications/@me`, { headers });
  if (!appRes.ok) return Response.json({ error: 'application lookup failed', status: appRes.status }, { status: 502 });
  const app = (await appRes.json()) as { id: string; verify_key: string; flags?: number; interactions_endpoint_url?: string };
  const report: Record<string, unknown> = {
    public_key_matches: app.verify_key === env.DISCORD_PUBLIC_KEY,
    message_content_intent: Boolean((app.flags ?? 0) & MESSAGE_CONTENT_FLAGS),
  };
  const endpoint = `${origin}/interactions`;
  if (app.interactions_endpoint_url === endpoint) {
    report.interactions_endpoint = 'unchanged';
  } else {
    // Discord validates the URL by sending signed PINGs to this Worker before accepting it.
    const patch = await fetch(`${api(env)}/applications/@me`, {
      method: 'PATCH', headers, body: JSON.stringify({ interactions_endpoint_url: endpoint }),
    });
    report.interactions_endpoint = patch.ok ? 'updated' : `failed (${patch.status})`;
  }
  const base = `${api(env)}/applications/${app.id}/guilds/${env.DISCORD_GUILD_ID}/commands`;
  const listRes = await fetch(base, { headers });
  if (!listRes.ok) return Response.json({ error: 'command list failed', status: listRes.status }, { status: 502 });
  const existing = ((await listRes.json()) as any[]).find((c) => c.name === COMMAND.name && (c.type ?? 1) === 1);
  if (existing && commandSignature(existing) === commandSignature(COMMAND)) {
    return Response.json({ ...report, command: 'unchanged' });
  }
  const res = await fetch(base, { method: 'POST', headers, body: JSON.stringify(COMMAND) });
  return Response.json({ ...report, command: res.ok ? 'registered' : `failed (${res.status})` }, { status: res.ok ? 200 : 502 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const notFound = new Response('Not found', { status: 404 });

    if (request.method === 'POST' && pathname === '/interactions') {
      const body = await request.text();
      const valid = await verifyInteraction(
        env.DISCORD_PUBLIC_KEY, request.headers.get('X-Signature-Ed25519'), request.headers.get('X-Signature-Timestamp'), body,
      );
      if (!valid) return new Response('invalid request signature', { status: 401 });
      const interaction = JSON.parse(body);
      if (interaction.type === 1) return Response.json({ type: 1 });
      if (interaction.type === 2 && interaction.data?.name === COMMAND.name) return handleCommand(interaction, env);
      return new Response('unsupported interaction', { status: 400 });
    }

    // Admin routes look identical to unknown paths unless the bearer token matches.
    if (!pathname.startsWith('/admin/') || !(await adminAuthorized(request, env))) return notFound;
    if (request.method === 'POST' && pathname === '/admin/setup') return setup(env, new URL(request.url).origin);
    if (request.method === 'GET' && pathname === '/admin/status') {
      return Response.json(await env.EXPORTER.getByName(env.DISCORD_GUILD_ID).status());
    }
    return notFound;
  },
} satisfies ExportedHandler<Env>;
