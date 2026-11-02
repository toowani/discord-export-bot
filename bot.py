"""Guild-scoped Discord JSON exporter. Never writes chat exports to disk."""
import asyncio
import io
import json
import logging
import math
import os
import signal
from datetime import datetime, timezone

import discord
from discord import app_commands
from aiohttp import web

LOG = logging.getLogger('export_bot')
MAX_BYTES = 8 * 1024 * 1024
MAX_MESSAGES = 25000
EXPORT_TIMEOUT = 12 * 60


class ExportLimit(Exception):
    pass


class Budget:
    def __init__(self):
        self.bytes = 0
        self.messages = 0

    def add(self, message):
        self.bytes += len(json.dumps(message, ensure_ascii=False).encode('utf-8'))
        self.messages += 1
        if self.bytes > MAX_BYTES or self.messages > MAX_MESSAGES:
            raise ExportLimit


def serialize_message(m):
    return {
        "id": str(m.id),
        "timestamp": m.created_at.isoformat(),
        "edited_at": (
            m.edited_at.isoformat()
            if m.edited_at else None
        ),
        "author": {
            "id": str(m.author.id),
            "name": m.author.display_name
        },
        "content": m.content,
        "attachments": [
            {
                "filename": a.filename,
                "url": a.url,
                "size": a.size
            }
            for a in m.attachments
        ],
        "reply_to": (
            str(m.reference.message_id)
            if m.reference else None
        ),
        "reactions": [
            {
                "emoji": str(r.emoji),
                "count": r.count
            }
            for r in m.reactions
        ],
        "url": m.jump_url
    }


def can_read(channel, member):
    permissions = channel.permissions_for(member)
    return permissions.view_channel and permissions.read_message_history


def command_signature(payload):
    """Fields that decide whether the registered command matches ours."""
    options = [
        {'name': o.get('name'), 'type': o.get('type'), 'description': o.get('description'),
         'required': bool(o.get('required', False)), 'channel_types': sorted(o.get('channel_types') or [])}
        for o in payload.get('options') or []
    ]
    return {'name': payload.get('name'), 'type': payload.get('type', 1),
            'description': payload.get('description'), 'options': options}


def is_authorized(member, role_name):
    p = member.guild_permissions
    return p.administrator or p.manage_guild or any(r.name == role_name for r in member.roles)


async def collect_messages(channel, budget):
    messages = []
    async for message in channel.history(limit=None, oldest_first=True):
        item = serialize_message(message)
        budget.add(item)
        messages.append(item)
    return messages


async def collect_threads(channel):
    threads, warnings = {}, []
    try:
        for thread in await channel.guild.active_threads():
            if thread.parent_id == channel.id and thread.type == discord.ChannelType.public_thread:
                threads[thread.id] = thread
    except discord.HTTPException:
        warnings.append('활성 공개 스레드 목록 조회 실패')
    try:
        async for thread in channel.archived_threads(private=False, limit=None):
            if thread.type == discord.ChannelType.public_thread:
                threads[thread.id] = thread
    except discord.HTTPException:
        warnings.append('보관된 공개 스레드 목록 조회 실패')
    return sorted(threads.values(), key=lambda t: t.id), warnings


async def build_export(target, member):
    budget = Budget()
    parent = await collect_messages(target, budget)
    threads, warnings = await collect_threads(target)
    results = []
    for thread in threads:
        if not can_read(thread, member) or not can_read(thread, target.guild.me):
            continue
        try:
            messages = await collect_messages(thread, budget)
            results.append({'thread_id': str(thread.id), 'thread_name': thread.name,
                            'archived': thread.archived, 'message_count': len(messages),
                            'messages': messages})
        except discord.HTTPException:
            warnings.append(f'공개 스레드 {thread.id} 수집 실패')
    count = sum(t['message_count'] for t in results)
    return {
        'guild_id': str(target.guild.id), 'guild_name': target.guild.name,
        'channel_id': str(target.id), 'channel_name': target.name,
        'exported_at': datetime.now(timezone.utc).isoformat(),
        'summary': {'parent_messages': len(parent), 'threads': len(results),
                    'thread_messages': count, 'total_messages': len(parent) + count},
        'parent_channel': {'messages': parent}, 'threads': results, 'warnings': warnings,
    }


class ExportBot(discord.Client):
    def __init__(self, guild_id, role_name):
        intents = discord.Intents.default()
        intents.message_content = True
        super().__init__(intents=intents, allowed_mentions=discord.AllowedMentions.none())
        self.guild_id = guild_id
        self.role_name = role_name
        self.export_lock = asyncio.Lock()
        self.tree = app_commands.CommandTree(self)
        self.health_runner = None
        self.gateway_up = False
        self.tree.add_command(app_commands.Command(
            name='내보내기', description='채널과 접근 가능한 공개 스레드를 JSON으로 내보냅니다.',
            callback=self.export_command), guild=discord.Object(id=guild_id))

    async def setup_hook(self):
        app = web.Application()
        app.router.add_get('/health', self.health)
        app.router.add_get('/livez', self.livez)
        self.health_runner = web.AppRunner(app, access_log=None)
        await self.health_runner.setup()
        # VM deployments bind to 127.0.0.1 so the health endpoint is never public.
        host = os.getenv('HEALTH_HOST', '0.0.0.0')
        await web.TCPSite(self.health_runner, host, int(os.getenv('PORT', '8080'))).start()
        await self.register_command()

    async def register_command(self):
        # Touch only /내보내기: a bulk tree.sync() would replace every guild command of this app.
        guild = discord.Object(id=self.guild_id)
        payload = self.tree.get_command('내보내기', guild=guild).to_dict(self.tree)
        existing = await self.http.get_guild_commands(self.application_id, self.guild_id)
        current = next((c for c in existing if c.get('name') == payload['name'] and c.get('type', 1) == 1), None)
        if current and command_signature(current) == command_signature(payload):
            LOG.info('명령어 확인 완료: /내보내기 (변경 없음)')
            return
        await self.http.upsert_guild_command(self.application_id, self.guild_id, payload)
        LOG.info('명령어 등록 완료: /내보내기')

    def gateway_connected(self):
        ws = self.ws
        return (self.gateway_up and self.is_ready() and not self.is_closed()
                and ws is not None and ws.open and math.isfinite(self.latency))

    async def health(self, request):
        if self.gateway_connected():
            return web.json_response({'status': 'ready', 'latency_ms': round(self.latency * 1000)})
        return web.json_response({'status': 'connecting'}, status=503)

    async def livez(self, request):
        return web.json_response({'status': 'alive'})

    async def on_ready(self):
        self.gateway_up = True
        LOG.info('봇 온라인; Discord Gateway 연결 완료')

    async def on_resumed(self):
        self.gateway_up = True
        LOG.info('Discord Gateway 세션 재개')

    async def on_disconnect(self):
        if self.gateway_up:
            LOG.warning('Discord Gateway 연결 끊김; 자동 재연결 시도')
        self.gateway_up = False

    async def on_error(self, event_method, *args, **kwargs):
        # Do not emit event payloads, message content, or interaction credentials.
        LOG.error('Discord 이벤트 처리 실패: %s', event_method)

    async def close(self):
        if self.health_runner:
            await self.health_runner.cleanup()
        await super().close()

    @app_commands.guild_only()
    @app_commands.describe(채널='내보낼 텍스트 채널 (생략하면 현재 채널)')
    async def export_command(self, interaction: discord.Interaction, 채널: discord.TextChannel = None):
        member = interaction.user
        if (interaction.guild_id != self.guild_id or not isinstance(member, discord.Member)
                or not is_authorized(member, self.role_name)):
            await interaction.response.send_message('서버 관리자 또는 대화내보내기 역할이 필요해요.', ephemeral=True)
            return
        target = 채널 or interaction.channel
        if isinstance(target, discord.Thread):
            if target.is_private():
                await interaction.response.send_message('비공개 스레드에서는 실행할 수 없어요.', ephemeral=True)
                return
            target = target.parent
        if not isinstance(target, discord.TextChannel) or target.guild.id != self.guild_id:
            await interaction.response.send_message('내보낼 텍스트 채널을 지정해 주세요.', ephemeral=True)
            return
        if not can_read(target, member) or target.guild.me is None or not can_read(target, target.guild.me):
            await interaction.response.send_message('사용자와 봇 모두 채널 보기·메시지 기록 보기 권한이 필요해요.', ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        if self.export_lock.locked():
            await interaction.followup.send('다른 내보내기가 진행 중이에요. 완료 후 다시 시도해 주세요.', ephemeral=True)
            return
        async with self.export_lock:
            try:
                async with asyncio.timeout(EXPORT_TIMEOUT):
                    output = await build_export(target, member)
                    content = json.dumps(output, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                    if len(content) > min(MAX_BYTES, interaction.filesize_limit):
                        raise ExportLimit
                    # Re-check access before delivering the file.
                    current_member = await target.guild.fetch_member(member.id)
                    if not is_authorized(current_member, self.role_name) or not can_read(target, current_member):
                        await interaction.followup.send('내보내기 권한이 변경되어 파일을 전송하지 않았어요.', ephemeral=True)
                        return
                    for result in output['threads']:
                        thread = await self.fetch_channel(int(result['thread_id']))
                        if not can_read(thread, current_member):
                            await interaction.followup.send('스레드 접근 권한이 변경되어 파일을 전송하지 않았어요.', ephemeral=True)
                            return
                    with discord.File(io.BytesIO(content), filename=f'discord_{target.id}.json') as attachment:
                        summary = output['summary']
                        await interaction.followup.send(
                            f"내보내기 완료: 메시지 {summary['total_messages']}개, 공개 스레드 {summary['threads']}개.\n"
                            f"수집 경고 {len(output['warnings'])}건. 비공개 스레드 제외, 첨부파일은 URL만 포함합니다.",
                            file=attachment, ephemeral=True)
                    LOG.info('내보내기 완료')
            except ExportLimit:
                await self.report(interaction, '8MB 또는 25,000개 메시지 제한을 초과했어요. 파일을 전송하지 않았어요.')
            except TimeoutError:
                await self.report(interaction, '12분 작업 제한을 초과했어요. 파일을 전송하지 않았어요.')
            except Exception as error:
                LOG.warning('내보내기 실패: %s', type(error).__name__)
                await self.report(interaction, '내보내기에 실패했어요. 채널 권한과 봇 상태를 확인해 주세요.')

    async def report(self, interaction, text):
        try:
            await interaction.followup.send(text, ephemeral=True)
        except discord.HTTPException:
            LOG.warning('Discord 비공개 응답 전송 실패')


def load_config():
    token = os.getenv('DISCORD_TOKEN', '').strip()
    guild_id = os.getenv('DISCORD_GUILD_ID', '').strip()
    if not token or not guild_id.isdecimal() or int(guild_id) <= 0:
        raise ValueError('DISCORD_TOKEN과 올바른 DISCORD_GUILD_ID 환경변수가 필요합니다.')
    return token, int(guild_id), os.getenv('ALLOWED_ROLE', '대화내보내기')


async def main():
    token, guild_id, role = load_config()
    bot = ExportBot(guild_id, role)
    loop = asyncio.get_running_loop()
    stopping = []

    def shutdown():
        # Cloudflare sends SIGTERM on restarts and rollouts; close the Gateway session cleanly.
        if not stopping:
            LOG.info('종료 신호 수신; Discord 연결 종료')
            stopping.append(asyncio.create_task(bot.close()))

    loop.add_signal_handler(signal.SIGTERM, shutdown)
    async with bot:
        await bot.start(token, reconnect=True)


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    # Library HTTP/debug logs can contain request URLs; keep production logging narrow.
    logging.getLogger('discord').setLevel(logging.CRITICAL)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as error:
        LOG.error('봇 시작 실패: %s. 환경변수, Message Content Intent, 서버 초대를 확인하세요.', type(error).__name__)
        raise SystemExit(1) from None
