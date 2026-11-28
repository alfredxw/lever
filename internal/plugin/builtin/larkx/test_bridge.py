import asyncio
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import types
import unittest
from unittest.mock import Mock, call

from bridge import (
    Channel,
    GatewayHTTP,
    TYPE_POST,
    cache_chat_info,
    fill_markdown_rich_text,
    install_full_push_decoder,
    markdown_plain_text,
    prepare_reply,
    render_normalized_markdown,
)


class BootstrapTest(unittest.TestCase):
    @unittest.skipUnless(platform.system() in ("Darwin", "Linux") and
                         platform.machine() in ("arm64", "aarch64", "x86_64"), "POSIX installer target")
    def test_corrupt_download_can_be_retried_without_publishing_an_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "plugin"
            package.mkdir()
            for name in ("bridge", "uv.lock"):
                shutil.copy(Path(__file__).with_name(name), package / name)
            tools = root / "bin"
            tools.mkdir()
            curl = tools / "curl"
            curl.write_text("#!/bin/sh\nwhile [ \"$1\" != -o ]; do shift; done\nprintf corrupt > \"$2\"\n")
            curl.chmod(0o700)
            session, cache = root / "session", root / "runtime"
            session.mkdir()
            env = {"PATH": str(tools) + os.pathsep + os.defpath, "HOME": directory,
                   "LEVER_CHANNEL_HOME": str(session), "LEVER_CHANNEL_CACHE": str(cache)}
            for _ in range(2):
                result = subprocess.run([package / "bridge", "listen", "feishu"], env=env,
                                        text=True, capture_output=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual([json.loads(line) for line in result.stdout.splitlines()],
                                 [{"event": "connecting", "phase": "preparing"}, {"event": "dependency"}])
                self.assertEqual(list(cache.iterdir()), [])
                self.assertEqual(list(session.iterdir()), [])


class Decoder:
    @staticmethod
    def message_dict(raw):
        return {"msg_type": 4, "from_type": 1, "chat_type": raw["kind"], "content": raw["body"], "from_id": raw["fromId"]}

    @staticmethod
    def is_thread_chat(info):
        return info.get("chatMode") == 2


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.client = Mock()
        self.client.get_chat_info.return_value = {"chatMode": 1}
        self.client.send_message.return_value = "1009"
        self.channel = Channel(self.client, "12", Decoder)
        self.raw = {"id": "50", "chatId": "66", "fromId": "12", "kind": 2, "body": "/ai hi",
                    "position": 17, "threadId": "50", "threadMessageType": 0, "createTime": self.channel.started}
        self.react = Mock(return_value={"count": 1})
        self.client.api.side_effect = lambda method, params: (
            self.react(params) if method == "reactions.PutReactionRequest" else {"messages": {"50": self.raw}}
        )

    def request(self, method, **fields):
        return self.channel.handle({"method": method, "chat": "66", "message": "50", **fields})

    def test_only_fresh_owner_messages(self):
        pushed = {"from_id": "12", "msg_type": 4, "create_time": self.channel.started, "chat_id": "66", "msg_id": "50", "content": "/ai hi"}
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            asyncio.run(self.channel.incoming({**pushed, "from_id": "15"}))
            asyncio.run(self.channel.incoming({**pushed, "create_time": self.channel.started - 1}))
            self.client.api.assert_not_called()
            for overrides in [{"fromId": "15"}, {"originalSenderId": "15"}, {"isRemoved": True}, {"chatId": "77"}]:
                self.client.api.return_value = {"messages": {"50": {**self.raw, **overrides}}}
                self.client.api.side_effect = None
                asyncio.run(self.channel.incoming(pushed))
            self.assertEqual(output.getvalue(), "")
            self.client.api.return_value = {"messages": {"50": self.raw}}
            asyncio.run(self.channel.incoming(pushed))
            self.assertIn('"event":"message"', output.getvalue())

    def test_group_quote_is_not_a_thread(self):
        self.raw.update(parentId="45", rootId="42")
        self.assertEqual(self.request("reply", text="direct")["status"], "ok")
        self.assertIsNone(self.client.send_message.call_args.kwargs["root_id"])
        self.assertEqual(self.request("reply", text="thread", thread="50")["status"], "ok")
        self.assertEqual(self.client.send_message.call_args.kwargs["root_id"], "50")

    def test_thread_cannot_escape_and_unknown_is_not_retried(self):
        self.raw.update(threadId="40", threadMessageType=2)
        self.assertEqual(self.request("reply", text="no")["status"], "failed")
        self.assertEqual(self.request("reply", thread="99", text="no")["status"], "failed")
        self.client.send_message.assert_not_called()
        self.client.send_message.return_value = None
        self.assertEqual(self.request("reply", thread="40", text="/ai output")["status"], "unknown")
        self.assertEqual(self.client.send_message.call_count, 1)
        self.assertFalse(self.client.send_message.call_args.args[0]["text"].startswith("/"))
        self.assertEqual(self.client.send_message.call_args.kwargs["parent_id"], "50")

    def test_topic_group_and_unknown_scope(self):
        self.client.get_chat_info.return_value = {"chatMode": 2, "name": "  产品研发群 \n "}
        origin = self.channel.origin(self.raw, "66")
        self.assertEqual(origin["thread"], "50")
        self.assertEqual(origin["chatName"], "产品研发群")
        reply = {**self.raw, "id": "51", "threadId": "50", "threadMessageType": 2}
        self.assertEqual(self.channel.origin(reply, "66")["chatName"], "产品研发群")
        self.client.get_chat_info.return_value = None
        self.assertIsNone(self.channel.origin(self.raw, "66"))

    def test_custom_reaction_only_on_original_command(self):
        self.assertEqual(self.request("react", reaction="DONE")["status"], "ok")
        self.react.assert_called_once_with({"messageId": "50", "reactionType": "DONE"})
        self.raw["fromId"] = "13"
        self.assertEqual(self.request("react", reaction="DONE")["status"], "failed")
        self.assertEqual(self.react.call_count, 1)

    def test_reaction_reuses_verified_push_without_another_lookup(self):
        pushed = {"from_id": "12", "msg_type": 4, "create_time": self.channel.started,
                  "chat_id": "66", "msg_id": "50", "content": "/ai hi"}
        with contextlib.redirect_stdout(io.StringIO()) as output:
            asyncio.run(self.channel.incoming(pushed))
        self.assertEqual(json.loads(output.getvalue())["event"], "message")
        self.react.assert_not_called()
        self.assertEqual(self.request("react", chat="77", reaction="DONE")["status"], "failed")
        self.client.api.reset_mock()
        self.assertEqual(self.request("react", reaction="DONE")["status"], "ok")
        self.client.api.assert_called_once_with("reactions.PutReactionRequest", {"messageId": "50", "reactionType": "DONE"})
        self.client.get_chat_info.assert_called_once_with("66")
        self.raw["isRemoved"] = True
        self.assertEqual(self.request("react", reaction="DONE")["status"], "failed")
        self.react.assert_called_once()

    def test_reaction_receipt_reflects_gateway_result(self):
        self.react.return_value = {"count": 0}
        self.assertEqual(self.request("react", reaction="DONE")["status"], "unknown")
        self.react.side_effect = TimeoutError()
        self.assertEqual(self.request("react", reaction="DONE")["status"], "unknown")
        rejected = RuntimeError()
        rejected.response = Mock(status_code=400)
        self.react.side_effect = rejected
        self.assertEqual(self.request("react", reaction="INVALID")["status"], "failed")

    def test_managed_sdk_decodes_owner_and_replies_to_the_command_in_its_thread(self):
        try:
            from larkx.proto import compose, decoders, proto_pb2
        except ModuleNotFoundError as error:
            if error.name not in ("larkx", "larkx.proto"):
                raise
            self.skipTest("run with the plugin's managed interpreter to exercise the pinned SDK")
        channel = Channel(self.client, "12", decoders, compose)
        self.raw.update(type=4, chatType=2, fromType="USER", createTime=channel.started,
                        content=proto_pb2.TextContent(text="/ai hi").SerializeToString())
        self.client.send_msg.return_value = "911"
        request = {"method": "reply", "chat": "66", "message": "50", "text": "answer"}
        self.assertEqual(channel.handle(request), {"status": "ok", "remoteId": "911"})
        self.client.send_msg.assert_called_once_with("answer", "66")
        self.assertEqual(channel.handle({**request, "method": "react", "reaction": "DONE"})["status"], "ok")
        self.raw.update(type=2, content=proto_pb2.PostContent(text="/ai rich").SerializeToString())
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            asyncio.run(channel.incoming(decoders.message_dict(self.raw)))
        self.assertIn('"/ai rich"', output.getvalue())
        self.raw.update(threadId="40", threadMessageType=2)
        for info, in_thread in [({"chatMode": 1}, True), ({"type": 3}, False)]:
            self.client.get_chat_info.return_value = info
            def gateway(method, params):
                if method == "messages.PullMessagesByIdsRequest":
                    return {"messages": {"50": self.raw}}
                self.assertEqual(method, "messages.PutMessageRequest")
                self.assertEqual((params["chatId"], params["rootId"], params["parentId"]), ("66", "40", "50"))
                self.assertEqual(params.get("isReplyInThread", False), in_thread)
                return {"message": {"id": "912"}}
            self.client.api.side_effect = gateway
            self.assertEqual(channel.handle({**request, "thread": "40"}), {"status": "ok", "remoteId": "912"})
        self.raw["fromType"] = "BOT"
        self.assertEqual(channel.handle({**request, "thread": "40"})["status"], "failed")
        self.assertEqual(self.client.send_msg.call_args_list, [call("answer", "66")])

    def test_context_is_bounded_to_thread_and_quote(self):
        self.raw.update(threadId="40", threadMessageType=2, threadPosition=7, parentId="45")

        def fetch(method, params):
            if method == "messages.PullMessagesByIdsRequest":
                return {"messages": {key: self.raw if key == "50" else {**self.raw, "id": key, "body": "quoted " + key} for key in params["messageIds"]}}
            self.assertEqual(params["positions"], [5, 6])
            self.assertEqual(params["threadId"], "40")
            return {"messages": {str(number): {**self.raw, "id": str(number), **patch} for number, patch in [
                (41, {"body": "related"}), (42, {"body": "other topic", "threadId": "123"}),
                (43, {"body": "other chat", "chatId": "77"}), (44, {"body": "future", "createTime": self.channel.started + 5}),
            ]}}

        self.client.api.side_effect = fetch
        context = self.request("context", limit=2)["text"]
        self.assertTrue(all(word in context for word in ("related", "quoted 40", "quoted 45")))
        self.assertFalse(any(word in context for word in ("other topic", "other chat", "future")))

    def test_history_failure_keeps_explicit_quote(self):
        self.raw["parentId"] = "45"

        def fetch(method, params):
            if method != "messages.PullMessagesByIdsRequest":
                raise TimeoutError()
            return {"messages": {key: self.raw if key == "50" else {**self.raw, "id": key, "body": "explicit quote"}
                                 for key in params["messageIds"]}}

        self.client.api.side_effect = fetch
        self.assertIn("explicit quote", self.request("context", limit=2)["text"])

    def test_pushed_raw_avoids_pull_and_reuses_cached_chat_and_context(self):
        fetch_chat = self.client.get_chat_info
        cache_chat_info(self.client)
        dm_raw = {**self.raw, "id": "51", "chatId": "88", "kind": 1, "parentId": "45"}
        dm_pushed = {"from_id": "12", "msg_type": 4, "create_time": self.channel.started,
                     "chat_id": "88", "msg_id": "51", "content": "/ai hi", "_raw": dm_raw}
        with contextlib.redirect_stdout(io.StringIO()) as output:
            asyncio.run(self.channel.incoming(dm_pushed))
        self.assertEqual(json.loads(output.getvalue())["message"]["kind"], "dm")
        self.client.api.assert_not_called()
        fetch_chat.assert_not_called()
        self.assertEqual(self.channel.handle({"method": "react", "chat": "88", "message": "51", "reaction": "OK"})["status"], "ok")
        self.client.api.assert_called_once_with("reactions.PutReactionRequest", {"messageId": "51", "reactionType": "OK"})

        self.client.api.reset_mock()
        for overrides in [{"originalSenderId": "15"}, {"isRemoved": True}, {"status": 2}, {"fromType": "BOT"}]:
            bad = {"from_id": "12", "msg_type": 4, "create_time": self.channel.started,
                   "chat_id": "66", "msg_id": "50", "content": "/ai hi", "_raw": {**self.raw, **overrides}}
            with contextlib.redirect_stdout(io.StringIO()) as output:
                asyncio.run(self.channel.incoming(bad))
            self.assertEqual(output.getvalue(), "")
        self.client.api.assert_not_called()

        for msg_id in ("52", "53"):
            group_raw = {**self.raw, "id": msg_id}
            pushed = {"from_id": "12", "msg_type": 4, "create_time": self.channel.started,
                      "chat_id": "66", "msg_id": msg_id, "content": "/ai hi", "_raw": group_raw}
            with contextlib.redirect_stdout(io.StringIO()) as output:
                asyncio.run(self.channel.incoming(pushed))
            self.assertEqual(json.loads(output.getvalue())["message"]["id"], msg_id)
        self.client.api.assert_not_called()
        fetch_chat.assert_called_once_with("66")

        def history_only(method, params):
            self.assertEqual(method, "messages.PullMessagesByPositionsRequest")
            return {"messages": {"16": {**self.raw, "id": "49", "body": "earlier"}}}

        self.client.api.side_effect = history_only
        ctx = self.channel.handle({"method": "context", "chat": "66", "message": "52", "limit": 1})
        self.assertEqual(ctx["status"], "ok")
        self.assertIn("earlier", ctx["text"])

        thread_raw = {**self.raw, "id": "54", "threadId": "40", "threadMessageType": 2, "parentId": "45"}
        thread_pushed = {"from_id": "12", "msg_type": 4, "create_time": self.channel.started,
                         "chat_id": "66", "msg_id": "54", "content": "/ai hi", "_raw": thread_raw}
        self.client.api.reset_mock()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            asyncio.run(self.channel.incoming(thread_pushed))
        self.assertEqual(json.loads(output.getvalue())["message"]["thread"], "40")
        self.client.api.assert_not_called()

    def test_group_reply_without_thread_mode_falls_back_to_server_lookup(self):
        ambiguous = {**self.raw, "parentId": "45", "threadId": "40", "threadMessageType": 0}
        pushed = {"from_id": "12", "msg_type": 4, "create_time": self.channel.started,
                  "chat_id": "66", "msg_id": "50", "content": "/ai hi", "_raw": ambiguous}
        self.raw.update(parentId="45", threadId="40", threadMessageType=2)
        with contextlib.redirect_stdout(io.StringIO()) as output:
            asyncio.run(self.channel.incoming(pushed))
        self.assertEqual(json.loads(output.getvalue())["message"]["thread"], "40")
        self.client.api.assert_called_once_with("messages.PullMessagesByIdsRequest", {"messageIds": ["50"]})

    def test_context_falls_back_when_cached_position_missing(self):
        no_pos = {**self.raw, "position": 0}
        pushed = {"from_id": "12", "msg_type": 4, "create_time": self.channel.started,
                  "chat_id": "66", "msg_id": "50", "content": "/ai hi", "_raw": no_pos}
        with contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(self.channel.incoming(pushed))
        self.client.api.reset_mock()
        seen = []

        def fetch(method, params):
            seen.append(method)
            if method == "messages.PullMessagesByIdsRequest":
                return {"messages": {"50": self.raw}}
            return {"messages": {"16": {**self.raw, "id": "49", "body": "prior"}}}

        self.client.api.side_effect = fetch
        ctx = self.request("context", limit=1)
        self.assertEqual(seen, ["messages.PullMessagesByIdsRequest", "messages.PullMessagesByPositionsRequest"])
        self.assertIn("prior", ctx["text"])

    def test_chat_info_cache_reuses_valid_entries_is_fail_closed_and_expires(self):
        now = [100.0]
        client = Mock()
        client.get_chat_info.side_effect = [{"chatMode": 1}, None, {}, {"chatMode": 2}, {"chatMode": 1}, {"chatMode": 2}]
        cache_chat_info(client, ttl=60, maxsize=2, clock=lambda: now[0])

        first = client.get_chat_info("66")
        first["chatMode"] = 99
        self.assertEqual(client.get_chat_info("66"), {"chatMode": 1})
        self.assertIsNone(client.get_chat_info("77"))
        self.assertEqual(client.get_chat_info("77"), {})
        self.assertEqual(client.get_chat_info("77"), {"chatMode": 2})

        now[0] += 61
        self.assertEqual(client.get_chat_info("66"), {"chatMode": 1})
        self.assertEqual(client.get_chat_info("88"), {"chatMode": 2})

    def test_gateway_http_pool_clears_idle_and_only_retries_safe_commands(self):
        class FakeConnError(Exception):
            pass

        fake_requests = types.SimpleNamespace(exceptions=types.SimpleNamespace(ConnectionError=FakeConnError))
        now = [10.0]
        clears = []
        session = Mock()
        http = GatewayHTTP(retry_commands=("25",), idle_seconds=25, clock=lambda: now[0],
                           session_factory=lambda: session, requests_module=fake_requests)
        http._clear_pool = lambda: clears.append(now[0])

        session.post.side_effect = ["r1", FakeConnError("stale"), "r2", FakeConnError("drop"), "r3"]
        self.assertEqual(http.post("https://example/gw", headers={"x-command": "25"}), "r1")
        self.assertEqual(http.post("https://example/gw", headers={"x-command": "25"}), "r2")
        self.assertEqual(len(clears), 1)
        with self.assertRaises(FakeConnError):
            http.post("https://example/gw", headers={"x-command": "5"})
        self.assertEqual(len(clears), 1)

        now[0] += 30
        self.assertEqual(http.post("https://example/gw", headers={"x-command": "25"}), "r3")
        self.assertEqual(len(clears), 2)

        session.post.side_effect = [FakeConnError("fresh-fail")]
        now[0] += 30
        with self.assertRaises(FakeConnError):
            http.post("https://example/gw", headers={"x-command": "25"})
        self.assertEqual(session.post.call_count, 6)

    def test_full_push_decoder_preserves_raw_and_thread_mode_on_sdk(self):
        try:
            if importlib.util.find_spec("larkx.protocol") is None:
                from larkx.proto import compose, decoders, gateway, proto_pb2
            else:
                from larkx.protocol.proto import decoders, gateway, proto_pb2
                compose = None
        except ModuleNotFoundError as error:
            if error.name not in ("larkx", "larkx.proto", "larkx.protocol"):
                raise
            self.skipTest("run with a larkx SDK interpreter to exercise full push decoding")
        original = decoders.push_messages
        try:
            self.assertTrue(install_full_push_decoder(decoders, gateway))
            channel = Channel(self.client, "12", decoders, compose)
            push_cls = gateway.resolve_type("messages.PushMessagesRequest")
            packet = push_cls()
            item = packet.messages["50"]
            item.id = "50"
            item.chatId = "66"
            item.fromId = "12"
            item.type = 4
            item.chatType = 2
            item.fromType = 1
            item.status = 1
            item.createTime = int(channel.started)
            item.position = 17
            item.threadId = "40"
            item.threadPosition = 7
            item.parentId = "45"
            item.rootId = "40"
            item.threadMessageType = 2
            item.content = proto_pb2.TextContent(text="/ai hi").SerializeToString()

            messages = decoders.push_messages(packet.SerializeToString())
            self.assertEqual(len(messages), 1)
            self.assertEqual(messages[0]["_raw"]["threadMessageType"], 2)

            self.client.api.reset_mock()
            with contextlib.redirect_stdout(io.StringIO()) as output:
                asyncio.run(channel.incoming(messages[0]))
            emitted = json.loads(output.getvalue())["message"]
            self.assertEqual((emitted["id"], emitted["thread"], emitted["parent"]), ("50", "40", "45"))
            self.client.api.assert_not_called()
        finally:
            decoders.push_messages = original

    def test_reply_detects_markdown_and_guards_hidden_slash_prefix(self):
        plain = "检查了 local_cache_dir 和 callback_url，2 * 3 * 4 = 24，见 https://example.com。\n\n—— AI · Agent"
        self.assertEqual(self.request("reply", text=plain)["status"], "ok")
        self.assertEqual(self.client.send_message.call_args.args[0], {"kind": "text", "text": plain})

        md = "## 结论\n\n- [x] 修复 `bridge.py`\n- [ ] 补充测试\n\n| 列A | 列B |\n| --- | --- |\n| `a | b` | **ok** |"
        self.assertEqual(self.request("reply", text=md)["status"], "ok")
        sent = self.client.send_message.call_args.args[0]
        self.assertEqual(sent["kind"], "markdown")
        self.assertIn("☑ 修复 `bridge.py`", sent["text"])
        self.assertIn("☐ 补充测试", sent["text"])
        self.assertIn("- **列A**：`a | b` ｜ **列B**：**ok**", sent["text"])
        self.assertNotIn("| --- |", sent["text"])

        for hidden_slash in ("**/ai** 说明", "`/ai` 说明", "[/ai](https://example.com)", "# /ai 标题",
                             "> /ai 引用", "```bash\n/ai run\n```", "---\n\n/ai hello", "```bash\n\n```\n/ai"):
            text, blocks, use_md = prepare_reply(hidden_slash)
            self.assertTrue(use_md, hidden_slash)
            self.assertFalse(text.lstrip().startswith("/"), hidden_slash)
            self.assertFalse(markdown_plain_text(blocks).lstrip().startswith("/"), hidden_slash)
            self.assertTrue(render_normalized_markdown(blocks).startswith("AI ·"), hidden_slash)

        # Degenerate markdown with no visible blocks falls back to plain text.
        for degenerate in ("---", ">\n>   "):
            _, _, use_md = prepare_reply(degenerate)
            self.assertFalse(use_md, degenerate)

    def test_reply_suffix_preserves_plain_text_and_formats_custom_markdown(self):
        for suffix, tail in [("", ""), ("   ", ""), ("收到 👍", "\n\n—— 收到 👍")]:
            with self.subTest(suffix=suffix):
                self.assertEqual(self.request("reply", text="完成", signature=suffix)["status"], "ok")
                self.assertEqual(self.client.send_message.call_args.args[0], {"kind": "text", "text": "完成" + tail})

        url = "https://example.com/docs"
        docs = "https://例子.测试/使用说明"
        for suffix, rendered in [
            (url, "—— " + url),
            (f"`{docs}` 和 **{docs}**。", f"—— `{docs}` 和 **[{docs}]({docs})**。"),
            (f"—— **📚 [文档]({url})**", f"—— **📚 [文档]({url})**"),
            (f"> 签名\r\n> [文档]({url})", f"——\n\n> 签名\n> [文档]({url})"),
        ]:
            with self.subTest(suffix=suffix):
                self.assertEqual(self.request("reply", text="完成", signature=suffix)["status"], "ok")
                self.assertEqual(self.client.send_message.call_args.args[0], {"kind": "markdown", "text": "完成\n\n" + rendered})
        self.assertEqual(self.request("reply", text="", signature=url)["status"], "failed")

    def test_managed_sdk_encodes_reply_suffix_as_a_separate_clickable_link(self):
        try:
            from larkx.proto import compose, gateway
        except ModuleNotFoundError as error:
            if error.name not in ("larkx", "larkx.proto"):
                raise
            self.skipTest("run with the managed SDK to verify native reply links")
        self.channel.compose = compose
        _, request_cls, _ = gateway.resolve_cmd("messages.PutMessageRequest")
        E = gateway._lark_all().entities.RichTextElement
        self.client.api.side_effect = lambda method, params: (
            {"messages": {"50": self.raw}} if method == "messages.PullMessagesByIdsRequest" else {"message": {"id": "920"}}
        )
        url = "https://github.com/alfredxw/lever"
        docs = "https://例子.测试/使用说明"
        for body, suffix, label, href in [
            ("收到", f"[Lever]({url})", "Lever", url),
            ("```py\nprint(1)", f"—— [Lever]({url})", "Lever", url),
            ("收到", docs, docs, docs),
        ]:
            with self.subTest(body=body, suffix=suffix):
                self.assertEqual(self.request("reply", text=body, thread="50", signature=suffix)["remoteId"], "920")
                method, data = self.client.api.call_args.args
                self.assertEqual(method, "messages.PutMessageRequest")
                request = gateway.request_from_dict(request_cls, data)
                self.assertEqual((request.type, request.rootId, request.parentId), (TYPE_POST, "50", "50"))
                rich = request.content.richText
                elements = rich.elements.dictionary
                footer = elements[elements[rich.elementIds[0]].childIds[-1]]
                prefix, anchor = [elements[item] for item in footer.childIds]
                self.assertEqual((prefix.tag, anchor.tag), (E.TEXT, E.A))
                self.assertEqual(E.TextProperty.FromString(prefix.property).content, "—— ")
                link = E.AnchorProperty.FromString(anchor.property)
                self.assertEqual((link.content, link.href, link.isCustom), (label, href, label != href))
                self.assertTrue(rich.innerText.endswith("\n—— " + label), rich.innerText)

    def test_managed_sdk_sends_markdown_post_and_falls_back_only_on_4xx(self):
        try:
            from larkx.proto import compose, decoders, gateway, proto_pb2
        except ModuleNotFoundError as error:
            if error.name not in ("larkx", "larkx.proto"):
                raise
            self.skipTest("run with the plugin's managed interpreter to exercise markdown rich text")

        channel = Channel(self.client, "12", decoders, compose)
        self.raw.update(type=4, chatType=2, fromType="USER", createTime=channel.started,
                        content=proto_pb2.TextContent(text="/ai hi").SerializeToString())
        L = gateway._lark_all()
        E = L.entities.RichTextElement
        _, req_cls, _ = gateway.resolve_cmd("messages.PutMessageRequest")

        md = (
            "## **结果汇总**\r\n\r\n"
            "***粗斜*** **加粗** __加粗2__ *斜体* _斜体2_ 保留 local_cache_dir 与 2 * 3 * 4\r\n"
            "行内 `code` 与 ``code ` tick``，**[文档](https://b.com)**、[**文档2**](https://c.com)、"
            "[`bridge.py`](https://d.com)、[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))、"
            "![图](https://e.com/a.png)、(见 HTTPS://KIRO.DEV/docs/skills。)\r\n\r\n"
            "> 引用第一行\r\n> 引用第二行\r\n>\r\n> 引用第二段\r\n\r\n"
            "- [x] 已完成\r\n- [ ] 待办\r\n  补充说明\r\n\r\n"
            "3. 第三步\r\n4. 第四步\r\n\r\n"
            "| 文件 | 改动 |\r\n| --- | --- |\r\n| `bridge.py` | 支持 `a | b` |\r\n\r\n"
            "```ts\r\nconst x: number = 1;\r\n```\r\n\r\n"
            "````markdown\r\n```py\r\nprint(1)\r\n```\r\n````\r\n\r\n"
            "—— AI · Agent"
        )

        captured = []

        def gateway_ok(method, params):
            if method == "messages.PullMessagesByIdsRequest":
                return {"messages": {"50": self.raw}}
            self.assertEqual(method, "messages.PutMessageRequest")
            captured.append(params)
            return {"message": {"id": "920"}}

        self.client.api.side_effect = gateway_ok
        # 1. Direct reply sends TYPE_POST via PutMessageRequest with no rootId/parentId.
        res = channel.handle({"method": "reply", "chat": "66", "message": "50", "text": md})
        self.assertEqual(res, {"status": "ok", "remoteId": "920"})
        self.client.send_msg.assert_not_called()
        self.assertEqual(len(captured), 1)
        self.assertNotIn("rootId", captured[0])
        self.assertNotIn("parentId", captured[0])
        rt_req = gateway.request_from_dict(req_cls, captured[0])
        self.assertEqual(rt_req.type, TYPE_POST)
        self.assertEqual(rt_req.content.richText.version, 1)
        self.assertTrue(rt_req.content.richText.innerText.strip())
        d = rt_req.content.richText.elements.dictionary
        self.assertEqual(sorted(d.keys(), key=int), [str(i + 1) for i in range(len(d))])
        self.assertTrue(all(d[k].HasField("property") for k in d))
        self.assertNotIn(30, {d[k].tag for k in d})  # CODE(30) never emitted
        # Verify CodeBlock languages (ts -> JS=0, markdown -> MARKDOWN=12) and inner fenced block preserved.
        code_blocks = [E.CodeBlockProperty.FromString(d[k].property) for k in sorted(d, key=int) if d[k].tag == 31]
        self.assertEqual([(cb.language, cb.content) for cb in code_blocks], [
            (0, "const x: number = 1;\n"),
            (12, "```py\nprint(1)\n```\n"),
        ])
        # Verify links (custom anchors + bare URL with uppercase scheme and trimmed CJK punct).
        anchors = [(E.AnchorProperty.FromString(d[k].property), dict(d[k].style))
                   for k in sorted(d, key=int) if d[k].tag == 6]
        self.assertEqual([(a.href, a.content, a.isCustom, a.scene, st) for a, st in anchors], [
            ("https://b.com", "文档", True, 3, {"fontWeight": "bold"}),
            ("https://c.com", "文档2", True, 3, {"fontWeight": "bold"}),
            ("https://d.com", "bridge.py", True, 3, {}),
            ("https://en.wikipedia.org/wiki/Foo_(bar)", "Wiki", True, 3, {}),
            ("https://e.com/a.png", "图", True, 3, {}),
            ("HTTPS://KIRO.DEV/docs/skills", "HTTPS://KIRO.DEV/docs/skills", False, 0, {}),
        ])
        # Verify bold/italic styling and untouched identifiers.
        text_leaves = [(E.TextProperty.FromString(d[k].property).content, dict(d[k].style))
                       for k in sorted(d, key=int) if d[k].tag == 1]
        self.assertIn(("结果汇总", {"fontWeight": "bold"}), text_leaves)
        self.assertIn(("粗斜", {"fontWeight": "bold", "fontStyle": "italic"}), text_leaves)
        self.assertIn(("加粗", {"fontWeight": "bold"}), text_leaves)
        self.assertIn(("加粗2", {"fontWeight": "bold"}), text_leaves)
        self.assertIn(("斜体", {"fontStyle": "italic"}), text_leaves)
        self.assertIn(("斜体2", {"fontStyle": "italic"}), text_leaves)
        self.assertTrue(any("local_cache_dir" in s and not st for s, st in text_leaves))
        self.assertTrue(any("code ` tick" in s and not st for s, st in text_leaves))
        # Verify roundtrip decoding via SDK decoders and context() extraction without "[富文本] ".
        def as_post_content(rich_text):
            post = proto_pb2.PostContent()
            post.richText.ParseFromString(rich_text.SerializeToString())
            return post.SerializeToString()

        post_raw = {**self.raw, "id": "920", "type": 2, "content": as_post_content(rt_req.content.richText)}
        decoded = decoders.message_dict(post_raw)
        extracted = channel.message_text(decoded)
        self.assertIn("结果汇总", extracted)
        self.assertIn("- ☑ 已完成", extracted)
        self.assertIn("1. 第三步", extracted)
        self.assertIn("文件：bridge.py", extracted)
        self.assertFalse(extracted.startswith("[富文本]"))

        # 2. Hidden slash inside Markdown never triggers origin() when echoed back as POST.
        # First confirm an unguarded POST starting with /ai WOULD trigger origin().
        unguarded_req = compose.message_request("66", markdown="**/ai** 说明")
        unguarded_echo = {**self.raw, "id": "924", "type": 2, "content": as_post_content(unguarded_req.content.richText)}
        self.assertIsNotNone(channel.origin(unguarded_echo, "66"))
        for slash_md in ("**/ai** 说明", "# /ai 标题", "`/ai` 说明", "> /ai 引用", "```bash\n/ai\n```"):
            _, blocks, use_md = prepare_reply(slash_md)
            self.assertTrue(use_md)
            req = compose.message_request("66", text="")
            req.type = TYPE_POST
            req.content.richText.Clear()
            self.assertTrue(fill_markdown_rich_text(req.content.richText, blocks, E))
            echo = {**self.raw, "id": "925", "type": 2, "content": as_post_content(req.content.richText)}
            self.assertIsNone(channel.origin(echo, "66"), slash_md)

        # 3. Thread reply sends TYPE_POST with rootId/parentId and proper isReplyInThread.
        self.raw.update(threadId="40", threadMessageType=2)
        for info, in_thread in [({"chatMode": 1}, True), ({"type": 3}, False)]:
            captured.clear()
            self.client.get_chat_info.return_value = info
            res = channel.handle({"method": "reply", "chat": "66", "message": "50", "thread": "40", "text": "**ok**"})
            self.assertEqual(res, {"status": "ok", "remoteId": "920"})
            self.assertEqual((captured[0]["chatId"], captured[0]["rootId"], captured[0]["parentId"]), ("66", "40", "50"))
            self.assertEqual(captured[0].get("isReplyInThread", False), in_thread)
            self.assertEqual(gateway.request_from_dict(req_cls, captured[0]).type, TYPE_POST)

        # 4. Explicit HTTP 400 on TYPE_POST falls back once to plain text; timeout/500 returns unknown without retry.
        self.raw.update(threadId="50", threadMessageType=0)
        self.client.get_chat_info.return_value = {"chatMode": 1}
        self.client.send_msg.reset_mock()
        self.client.send_msg.return_value = "921"

        def reject_400(method, params):
            if method == "messages.PullMessagesByIdsRequest":
                return {"messages": {"50": self.raw}}
            err = RuntimeError("bad rich text")
            err.response = Mock(status_code=400)
            raise err

        self.client.api.side_effect = reject_400
        res = channel.handle({"method": "reply", "chat": "66", "message": "50", "text": "**bold**"})
        self.assertEqual(res, {"status": "ok", "remoteId": "921"})
        self.client.send_msg.assert_called_once_with("**bold**", "66")

        self.client.send_msg.reset_mock()
        res = channel.handle({"method": "reply", "chat": "66", "message": "50", "text": "完成",
                              "signature": "[Lever](https://github.com/alfredxw/lever)"})
        self.assertEqual(res, {"status": "ok", "remoteId": "921"})
        self.client.send_msg.assert_called_once_with("完成\n\n—— Lever (https://github.com/alfredxw/lever)", "66")
        self.client.send_msg.reset_mock()

        def fail_500(method, params):
            if method == "messages.PullMessagesByIdsRequest":
                return {"messages": {"50": self.raw}}
            err = RuntimeError("server error")
            err.response = Mock(status_code=502)
            raise err

        self.client.api.side_effect = fail_500
        res = channel.handle({"method": "reply", "chat": "66", "message": "50", "text": "**bold**"})
        self.assertEqual(res, {"status": "unknown"})
        self.client.send_msg.assert_not_called()

        # 5. Thread HTTP 400 falls back to threaded plain text (TYPE_TEXT=4) preserving rootId/parentId.
        self.raw.update(threadId="40", threadMessageType=2)
        self.client.get_chat_info.return_value = {"chatMode": 1}
        thread_types = []

        def reject_post_accept_text(method, params):
            if method == "messages.PullMessagesByIdsRequest":
                return {"messages": {"50": self.raw}}
            parsed = gateway.request_from_dict(req_cls, params)
            thread_types.append((parsed.type, parsed.rootId, parsed.parentId))
            if parsed.type == TYPE_POST:
                err = RuntimeError("bad rich text")
                err.response = Mock(status_code=400)
                raise err
            return {"message": {"id": "922"}}

        self.client.api.side_effect = reject_post_accept_text
        res = channel.handle({"method": "reply", "chat": "66", "message": "50", "thread": "40", "text": "**bold**"})
        self.assertEqual(res, {"status": "ok", "remoteId": "922"})
        self.assertEqual(thread_types, [(2, "40", "50"), (4, "40", "50")])
