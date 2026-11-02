"""Offline tests with fake Discord objects; no network or token required."""
import asyncio
import json
import math
from datetime import datetime, timezone
from types import SimpleNamespace

import discord
import pytest

import bot


def perms(view=True, history=True):
    return SimpleNamespace(view_channel=view, read_message_history=history)


class FakeChannel:
    def __init__(self, cid, readable=True, kind=discord.ChannelType.public_thread, parent_id=1):
        self.id, self.type, self.parent_id = cid, kind, parent_id
        self.readable = readable

    def permissions_for(self, member):
        return perms(self.readable, self.readable)


def member(admin=False, manage=False, roles=()):
    return SimpleNamespace(
        guild_permissions=SimpleNamespace(administrator=admin, manage_guild=manage),
        roles=[SimpleNamespace(name=r) for r in roles])


def make_bot():
    return bot.ExportBot(123, '대화내보내기')


def test_command_is_guild_scoped_with_optional_text_channel():
    client = make_bot()
    cmd = client.tree.get_command('내보내기', guild=discord.Object(id=123))
    payload = cmd.to_dict(client.tree)
    assert client.tree.get_command('내보내기') is None  # not global
    [option] = payload['options']
    assert option['name'] == '채널' and not option.get('required', False)
    assert discord.ChannelType.text.value in option['channel_types']
    assert client.intents.message_content


def test_command_signature_ignores_server_fields_and_detects_changes():
    client = make_bot()
    payload = client.tree.get_command('내보내기', guild=discord.Object(id=123)).to_dict(client.tree)
    remote = dict(payload, id='1', application_id='2', version='3', guild_id='123')
    assert bot.command_signature(remote) == bot.command_signature(payload)
    assert bot.command_signature(dict(payload, description='다름')) != bot.command_signature(payload)


def test_authorization_and_channel_access():
    assert bot.is_authorized(member(admin=True), '대화내보내기')
    assert bot.is_authorized(member(manage=True), '대화내보내기')
    assert bot.is_authorized(member(roles=['대화내보내기']), '대화내보내기')
    assert not bot.is_authorized(member(roles=['기타']), '대화내보내기')
    assert bot.can_read(FakeChannel(1), None)
    assert not bot.can_read(FakeChannel(1, readable=False), None)


def test_only_public_threads_of_target_are_collected():
    public = FakeChannel(10)
    private = FakeChannel(11, kind=discord.ChannelType.private_thread)
    other_parent = FakeChannel(12, parent_id=99)
    archived_public = FakeChannel(13)
    seen = {}

    async def active_threads():
        return [public, private, other_parent]

    async def archived_threads(private, limit):
        seen['private'] = private
        for t in [archived_public, FakeChannel(14, kind=discord.ChannelType.private_thread)]:
            yield t

    target = SimpleNamespace(id=1, guild=SimpleNamespace(active_threads=active_threads),
                             archived_threads=archived_threads)
    threads, warnings = asyncio.run(bot.collect_threads(target))
    assert [t.id for t in threads] == [10, 13]
    assert seen['private'] is False and warnings == []


def test_budget_limits(monkeypatch):
    monkeypatch.setattr(bot, 'MAX_MESSAGES', 2)
    budget = bot.Budget()
    budget.add({'a': 1})
    budget.add({'a': 2})
    with pytest.raises(bot.ExportLimit):
        budget.add({'a': 3})
    monkeypatch.setattr(bot, 'MAX_BYTES', 10)
    with pytest.raises(bot.ExportLimit):
        bot.Budget().add({'content': '가' * 10})


def test_serialized_message_keeps_korean_and_attachment_urls_only():
    m = SimpleNamespace(
        id=5, created_at=datetime(2026, 1, 1, tzinfo=timezone.utc), edited_at=None,
        author=SimpleNamespace(id=7, display_name='와니'), content='안녕하세요',
        attachments=[SimpleNamespace(filename='a.png', url='https://cdn/a.png', size=3)],
        reference=None, reactions=[SimpleNamespace(emoji='👍', count=2)], jump_url='https://discord/x')
    item = bot.serialize_message(m)
    text = json.dumps(item, ensure_ascii=False)
    assert '안녕하세요' in text and '와니' in text
    assert item['attachments'] == [{'filename': 'a.png', 'url': 'https://cdn/a.png', 'size': 3}]


def test_health_reflects_gateway_state(monkeypatch):
    client = make_bot()
    assert not client.gateway_connected()
    client._ready = asyncio.Event()
    client._ready.set()
    client.gateway_up = True
    client.ws = SimpleNamespace(open=True, latency=0.05)
    monkeypatch.setattr(bot.ExportBot, 'latency', property(lambda self: self.ws.latency if self.ws else math.inf))
    client._closing_task = None
    client._closed = False
    assert client.gateway_connected()
    client.ws.open = False
    assert not client.gateway_connected()
    client.ws.open = True
    asyncio.run(client.on_disconnect())
    assert not client.gateway_connected()


def test_load_config_requires_token_and_numeric_guild(monkeypatch):
    monkeypatch.setenv('DISCORD_TOKEN', 'x')
    monkeypatch.setenv('DISCORD_GUILD_ID', 'abc')
    with pytest.raises(ValueError):
        bot.load_config()
    monkeypatch.setenv('DISCORD_GUILD_ID', '42')
    monkeypatch.delenv('ALLOWED_ROLE', raising=False)
    assert bot.load_config() == ('x', 42, '대화내보내기')
