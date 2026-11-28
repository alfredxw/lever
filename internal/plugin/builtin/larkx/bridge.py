import asyncio
import contextlib
import importlib.util
import json
import os
import re
import sys
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


SAFE_RETRY_METHODS = (
    "messages.PullMessagesByIdsRequest",
    "chats.PullChatsByIdsRequest",
    "messages.PullMessagesByPositionsRequest",
    "thread.PullThreadMessagesByPositionsRequest",
    "improto.PullPacketsBySidsRequest",
    "reactions.PutReactionRequest",
)


def identifier(value):
    value = str(value or "")
    return value if value.isascii() and value.isdecimal() and not value.startswith("0") else ""


class _PooledRequests:
    def __init__(self, target, post):
        self._target = target
        self.post = post

    def __getattr__(self, name):
        return getattr(self._target, name)


class GatewayHTTP:
    def __init__(self, retry_commands=(), idle_seconds=25, clock=time.monotonic, session_factory=None, requests_module=None):
        import http.cookiejar

        if requests_module is None:
            import requests as requests_module
        self.requests = requests_module
        self.retry_commands = {str(cmd) for cmd in retry_commands}
        self.idle_seconds = idle_seconds
        self.clock = clock
        self.local = threading.local()
        self.lock = threading.Lock()
        self.last_used = 0.0
        self.adapter = None
        if session_factory is None:
            from requests.adapters import HTTPAdapter

            class NoStoreCookies(http.cookiejar.DefaultCookiePolicy):
                def set_ok(self, cookie, request):
                    return False

            policy = NoStoreCookies()
            adapter = HTTPAdapter(pool_connections=4, pool_maxsize=16)
            self.adapter = adapter

            def session_factory():
                session = requests_module.Session()
                session.cookies.set_policy(policy)
                session.mount("https://", adapter)
                session.mount("http://", adapter)
                return session

        self._session_factory = session_factory

    def _session(self):
        session = getattr(self.local, "session", None)
        if session is None:
            session = self._session_factory()
            self.local.session = session
        return session

    def _clear_pool(self):
        if self.adapter is not None:
            self.adapter.poolmanager.clear()

    def post(self, url, **kwargs):
        now = self.clock()
        reused = False
        with self.lock:
            if self.last_used:
                if now - self.last_used > self.idle_seconds:
                    self._clear_pool()
                    self.last_used = 0.0
                else:
                    reused = True
        cmd = str((kwargs.get("headers") or {}).get("x-command") or "")
        try:
            resp = self._session().post(url, **kwargs)
        except self.requests.exceptions.ConnectionError:
            if not reused or cmd not in self.retry_commands:
                raise
            with self.lock:
                self._clear_pool()
                self.last_used = 0.0
            resp = self._session().post(url, **kwargs)
        done = self.clock()
        with self.lock:
            self.last_used = max(self.last_used, done)
        return resp


def install_gateway_http(client, gateway, idle_seconds=25):
    retry_commands = set()
    for method in SAFE_RETRY_METHODS:
        with contextlib.suppress(Exception):
            retry_commands.add(str(gateway.resolve_cmd(method)[0]))
    client_module = sys.modules.get(type(client).__module__)
    target = getattr(client_module, "requests", None) if client_module is not None else None
    if target is None or isinstance(target, _PooledRequests):
        return None
    pooled = GatewayHTTP(retry_commands=retry_commands, idle_seconds=idle_seconds, requests_module=target)
    client_module.requests = _PooledRequests(target, pooled.post)
    return pooled


def cache_chat_info(client, ttl=600, maxsize=512, clock=time.monotonic):
    fetch = getattr(client, "get_chat_info", None)
    if fetch is None:
        return
    entries = OrderedDict()
    lock = threading.Lock()

    def get_chat_info(chat_id):
        key = str(chat_id)
        now = clock()
        with lock:
            item = entries.get(key)
            if item is not None:
                if now - item[0] <= ttl:
                    entries.move_to_end(key)
                    return dict(item[1])
                del entries[key]
        info = fetch(key)
        if isinstance(info, dict) and (info.get("chatMode") or info.get("type")):
            stored = dict(info)
            with lock:
                entries[key] = (clock(), stored)
                entries.move_to_end(key)
                if len(entries) > maxsize:
                    entries.popitem(last=False)
            return dict(stored)
        return info

    client.get_chat_info = get_chat_info


def install_full_push_decoder(decoders, gateway):
    fallback = getattr(decoders, "push_messages", None)
    to_dict = getattr(decoders, "protobuf_to_dict", None) or getattr(gateway, "protobuf_to_dict", None)
    if fallback is None or to_dict is None:
        return False
    try:
        push_cls = gateway.resolve_type("messages.PushMessagesRequest")
    except Exception:
        return False

    def push_messages(payload):
        if not payload:
            return []
        try:
            packet = push_cls()
            packet.ParseFromString(payload)
            at_me_map = dict(packet.messagesAtMe)
            out = []
            for key, item in packet.messages.items():
                raw = to_dict(item)
                msg = decoders.message_dict(raw, at_me=bool(at_me_map.get(raw.get("id")) or at_me_map.get(key)))
                msg["_raw"] = raw
                out.append(msg)
            return out
        except Exception:
            return fallback(payload)

    decoders.push_messages = push_messages
    return True


TYPE_POST = 2
RT_TEXT, RT_PARA, RT_LINK, RT_DOCS, RT_UL, RT_OL, RT_LI, RT_QUOTE, RT_CODE_BLOCK = 1, 3, 6, 22, 26, 27, 28, 29, 31
RT_BOLD = ("fontWeight", "bold")
RT_ITALIC = ("fontStyle", "italic")
RT_ANCHOR_CUSTOM = 3  # AnchorProperty.Scene.CUSTOM_EDIT

# CodeBlockProperty.Language (V1 enum); unknown languages default to SHELL (20).
CODE_LANGS = {
    "js": 0, "javascript": 0, "jsx": 0, "mjs": 0, "cjs": 0, "ts": 0, "typescript": 0, "tsx": 0,
    "apache": 1, "apacheconf": 1,
    "bash": 2, "sh": 2, "zsh": 2, "fish": 2, "console": 2,
    "cs": 3, "csharp": 3, "c#": 3,
    "cpp": 4, "c++": 4, "c": 4, "cc": 4, "cxx": 4, "h": 4, "hpp": 4, "hh": 4,
    "coffee": 5, "coffeescript": 5,
    "html": 6, "htm": 6, "xhtml": 6, "vue": 6, "svelte": 6,
    "xml": 7, "svg": 7, "plist": 7, "xsl": 7, "xsd": 7,
    "http": 8,
    "json": 9, "jsonc": 9, "json5": 9, "jsonl": 9,
    "java": 10,
    "makefile": 11, "make": 11, "mk": 11,
    "markdown": 12, "md": 12, "mdx": 12,
    "nginx": 13, "nginxconf": 13,
    "objc": 14, "obj-c": 14, "objectivec": 14, "objective-c": 14,
    "php": 15,
    "perl": 16, "pl": 16,
    "py": 17, "python": 17, "python3": 17, "pyi": 17,
    "ruby": 18, "rb": 18,
    "sql": 19, "mysql": 19, "postgresql": 19, "postgres": 19, "sqlite": 19, "plsql": 19,
    "shell": 20,
    "go": 21, "golang": 21,
    "scss": 22, "sass": 22, "css": 22, "less": 22,
    "lua": 23,
    "django": 24, "jinja": 24, "jinja2": 24,
    "kotlin": 25, "kt": 25, "kts": 25,
}
DEFAULT_CODE_LANG = 20

FENCE_BACKTICK_RE = re.compile(r"^[ \t]*(`{3,})[ \t]*([^\s`]*)(?:[ \t]+[^`]*)?$")
FENCE_TILDE_RE = re.compile(r"^[ \t]*(~{3,})[ \t]*([^\s~]*).*$")
HEADING_RE = re.compile(r"^[ \t]*#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$")
RULE_RE = re.compile(r"^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$")
QUOTE_RE = re.compile(r"^[ \t]*>[ \t]?(.*)$")
UL_ITEM_RE = re.compile(r"^([ \t]*)[-*+][ \t]+(\S.*)$")
OL_ITEM_RE = re.compile(r"^([ \t]*)(\d{1,9})[.)][ \t]+(\S.*)$")
TASK_CHECKED_RE = re.compile(r"^\[[xX]\][ \t]+(.+)$")
TASK_UNCHECKED_RE = re.compile(r"^\[ \][ \t]+(.+)$")
TABLE_SEP_CELL_RE = re.compile(r"^:?-{1,}:?$")

# Inline Markdown tokens. Inline code is matched first so formatting/URLs inside backticks stay literal.
# Use local (?i:https?) instead of global re.I to avoid Python's Unicode case-folding bug on non-ASCII negated classes.
INLINE_CODE_OR_LINK = (
    r"``(?:[^`\n]|`(?!`))+``"
    r"|`[^`\n]+`"
    r"|!?\[[^\]\n]{1,400}\]\((?i:https?)://(?:[^\s()]|\([^\s()]*\)){1,4000}(?:[ \t]+\"[^\"\n]*\")?\)"
)
# Allow Unicode names and paths, leaving surrounding CJK punctuation and emoji outside the link.
BARE_URL = r"(?i:https?)://[\w./:%?#@!$&'()*+,;=~\[\]-]{1,4000}"
INLINE_RE = re.compile(
    f"({INLINE_CODE_OR_LINK}"
    r"|\*\*\*(?=\S)[^\n]+?(?<=\S)\*\*\*"
    r"|\*\*(?=\S)[^\n]+?(?<=\S)\*\*"
    r"|(?<!\w)__(?=\S)[^\n]+?(?<=\S)__(?!\w)"
    r"|(?<!\*)\*(?![*\s])[^\n]+?(?<![\s*])\*(?!\*)"
    r"|(?<![\w_])_(?![_\s])[^_\n]*?(?<=\S)_(?![\w_])"
    f"|{BARE_URL})"
)
SDK_LINK_RE = re.compile(f"{INLINE_CODE_OR_LINK}|(?P<url>{BARE_URL})")
LINK_MD_RE = re.compile(
    r"^(!?)\[([^\]]*)\]\(((?i:https?)://(?:[^\s()]|\([^\s()]*\))+)(?:[ \t]+\"[^\"\n]*\")?\)$"
)
_URL_TRAILING_PUNCT = set("?!.,:;*_~'\"")
_URL_CLOSE_BRACKETS = {")": "(", "]": "[", "}": "{"}


def _match_fence_open(line):
    match = FENCE_BACKTICK_RE.match(line) or FENCE_TILDE_RE.match(line)
    if not match:
        return None
    fence = match.group(1)
    return fence[0], len(fence), match.group(2).strip()


def _is_fence_close(line, fence_char, fence_len):
    stripped = line.strip()
    return len(stripped) >= fence_len and set(stripped) == {fence_char}


def _split_table_row(line):
    text = line.strip()
    if text.startswith("|"):
        text = text[1:]
    if text.endswith("|") and not text.endswith("\\|"):
        text = text[:-1]
    cells = []
    buf = []
    in_code = False
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text) and text[i + 1] == "|":
            buf.append("|")
            i += 2
            continue
        if ch == "`":
            in_code = not in_code
            buf.append(ch)
        elif ch == "|" and not in_code:
            cells.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
        i += 1
    cells.append("".join(buf).strip())
    return cells


def _is_table_separator(line, expected_cols):
    stripped = line.strip()
    if "|" not in stripped or "-" not in stripped:
        return False
    cells = _split_table_row(stripped)
    if not cells or len(cells) != expected_cols:
        return False
    if len(cells) == 1:
        if not (stripped.startswith("|") and stripped.endswith("|")):
            return False
        return bool(re.match(r"^:?-{3,}:?$", cells[0]))
    return all(TABLE_SEP_CELL_RE.match(cell) for cell in cells)


def _trim_bare_url(url):
    while url:
        ch = url[-1]
        if ch in _URL_TRAILING_PUNCT:
            url = url[:-1]
        elif ch in _URL_CLOSE_BRACKETS and url.count(ch) > url.count(_URL_CLOSE_BRACKETS[ch]):
            url = url[:-1]
        else:
            break
    return url


def _inline_tokens(text, styles=()):
    for index, part in enumerate(INLINE_RE.split(text or "")):
        if not part:
            continue
        if index % 2 == 0:
            yield "text", part, "", styles
        elif part.startswith("``") and part.endswith("``") and len(part) > 4:
            code = part[2:-2]
            if len(code) >= 2 and code[0] == " " and code[-1] == " " and code.strip():
                code = code[1:-1]
            yield "code", code, "", styles
        elif part.startswith("`") and part.endswith("`") and len(part) >= 2:
            yield "code", part[1:-1], "", styles
        elif part[0] in ("!", "["):
            match = LINK_MD_RE.match(part)
            if not match:
                yield "text", part, "", styles
                continue
            raw_label, url = match.group(2), match.group(3)
            if raw_label.strip():
                inner = list(_inline_tokens(raw_label, styles))
                plain_label = "".join(item[1] for item in inner)
                non_ws = [item[3] for item in inner if item[1].strip()]
                link_styles = styles
                if non_ws:
                    common = set(non_ws[0])
                    for st in non_ws[1:]:
                        common &= set(st)
                    link_styles = tuple(dict.fromkeys(styles + tuple(st for st in non_ws[0] if st in common)))
                yield "link", plain_label or raw_label, url, link_styles
            else:
                yield "url", url, url, styles
        elif len(part) > 6 and part[:3] == part[-3:] == "***":
            yield from _inline_tokens(part[3:-3], styles + (RT_BOLD, RT_ITALIC))
        elif part[:2] in ("**", "__"):
            yield from _inline_tokens(part[2:-2], styles + (RT_BOLD,))
        elif part[0] in ("*", "_"):
            yield from _inline_tokens(part[1:-1], styles + (RT_ITALIC,))
        else:
            url = _trim_bare_url(part)
            yield "url", url, url, styles
            if len(part) > len(url):
                yield "text", part[len(url):], "", styles


def _has_inline_markdown(line, linkify_urls):
    return any(kind in ("code", "link") or (linkify_urls and kind == "url") or styles
               for kind, _, _, styles in _inline_tokens(line))


def _format_task_item(text):
    checked = TASK_CHECKED_RE.match(text)
    if checked:
        return "☑ " + checked.group(1)
    unchecked = TASK_UNCHECKED_RE.match(text)
    if unchecked:
        return "☐ " + unchecked.group(1)
    return text


def _starts_table(lines, index):
    if index + 1 >= len(lines) or "|" not in lines[index]:
        return False
    headers = _split_table_row(lines[index])
    return bool(headers) and _is_table_separator(lines[index + 1], len(headers))


def _is_block_start(lines, index):
    raw = lines[index]
    stripped = raw.strip()
    if not stripped:
        return False
    return bool(
        _match_fence_open(raw)
        or RULE_RE.match(raw)
        or HEADING_RE.match(raw)
        or QUOTE_RE.match(raw)
        or UL_ITEM_RE.match(raw)
        or OL_ITEM_RE.match(raw)
        or _starts_table(lines, index)
    )


def parse_markdown_blocks(text, *, linkify_urls=False):
    lines = (text or "").split("\n")
    blocks = []
    is_markdown = False
    i = 0
    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()
        if not stripped:
            i += 1
            continue
        fence = _match_fence_open(raw)
        if fence:
            fence_char, fence_len, lang = fence
            body = []
            i += 1
            while i < len(lines) and not _is_fence_close(lines[i], fence_char, fence_len):
                body.append(lines[i])
                i += 1
            if i < len(lines):
                i += 1
            blocks.append(("code", lang, "\n".join(body)))
            is_markdown = True
            continue
        if RULE_RE.match(raw):
            is_markdown = True
            i += 1
            continue
        heading = HEADING_RE.match(raw)
        if heading:
            blocks.append(("heading", heading.group(1).strip()))
            is_markdown = True
            i += 1
            continue
        if QUOTE_RE.match(raw):
            quote_paras = []
            current_lines = []
            while i < len(lines) and QUOTE_RE.match(lines[i]):
                content = QUOTE_RE.match(lines[i]).group(1).strip()
                if not content:
                    if current_lines:
                        quote_paras.append((False, current_lines))
                        current_lines = []
                else:
                    qhead = HEADING_RE.match(content)
                    if qhead:
                        if current_lines:
                            quote_paras.append((False, current_lines))
                            current_lines = []
                        quote_paras.append((True, [qhead.group(1).strip()]))
                    else:
                        current_lines.append(content)
                i += 1
            if current_lines:
                quote_paras.append((False, current_lines))
            if quote_paras:
                blocks.append(("quote", quote_paras))
                is_markdown = True
            continue
        if _starts_table(lines, i):
            headers = _split_table_row(lines[i])
            i += 2
            rows = []
            while i < len(lines):
                row_raw = lines[i]
                if (not row_raw.strip() or "|" not in row_raw or _match_fence_open(row_raw)
                        or RULE_RE.match(row_raw) or HEADING_RE.match(row_raw) or QUOTE_RE.match(row_raw)):
                    break
                rows.append(_split_table_row(row_raw))
                i += 1
            blocks.append(("table", headers, rows))
            is_markdown = True
            continue
        ul = UL_ITEM_RE.match(raw)
        ol = OL_ITEM_RE.match(raw)
        if ul or ol:
            ordered = bool(ol)
            start = max(1, min(int(ol.group(2)), 2147483647)) if ol else 1
            items = []
            while i < len(lines):
                match = OL_ITEM_RE.match(lines[i]) if ordered else UL_ITEM_RE.match(lines[i])
                if not match:
                    break
                first_line = match.group(3) if ordered else _format_task_item(match.group(2))
                item_lines = [first_line.strip()]
                i += 1
                while i < len(lines):
                    nxt = lines[i]
                    if not nxt.strip() or not nxt[0].isspace() or _is_block_start(lines, i):
                        break
                    item_lines.append(nxt.strip())
                    i += 1
                items.append(item_lines)
            if items:
                blocks.append(("ol", start, items) if ordered else ("ul", items))
                is_markdown = True
            continue
        para_lines = [stripped]
        if not is_markdown and _has_inline_markdown(stripped, linkify_urls):
            is_markdown = True
        i += 1
        while i < len(lines):
            nxt = lines[i]
            s = nxt.strip()
            if not s or _is_block_start(lines, i):
                break
            para_lines.append(s)
            if not is_markdown and _has_inline_markdown(s, linkify_urls):
                is_markdown = True
            i += 1
        blocks.append(("para", para_lines))
    if not blocks:
        return [], False
    return blocks, is_markdown


def _plain_inline(text):
    return "".join(
        f"{content} ({url})" if kind == "link" else content
        for kind, content, url, _ in _inline_tokens(text)
    )


def _table_row_fields(headers, row):
    fields = []
    for idx, cell in enumerate(row):
        if not cell:
            continue
        header = headers[idx] if idx < len(headers) else ""
        fields.append((header, cell))
    return fields


def markdown_plain_text(blocks):
    parts = []
    for block in blocks:
        kind = block[0]
        if kind == "code":
            if block[2]:
                parts.append(block[2])
        elif kind == "heading":
            parts.append(_plain_inline(block[1]))
        elif kind == "quote":
            for _, q_lines in block[1]:
                parts.append("\n".join(_plain_inline(line) for line in q_lines))
        elif kind == "ul":
            for item_lines in block[1]:
                parts.append("- " + "\n".join(_plain_inline(line) for line in item_lines))
        elif kind == "ol":
            start = block[1]
            for offset, item_lines in enumerate(block[2]):
                parts.append(f"{start + offset}. " + "\n".join(_plain_inline(line) for line in item_lines))
        elif kind == "table":
            headers, rows = block[1], block[2]
            emitted = False
            for row in rows:
                fields = _table_row_fields(headers, row)
                if not fields:
                    continue
                emitted = True
                cells = [f"{_plain_inline(h)}：{_plain_inline(c)}" if h else _plain_inline(c) for h, c in fields]
                parts.append("- " + " ｜ ".join(cells))
            if not emitted:
                hdrs = [_plain_inline(h) for h in headers if h]
                if hdrs:
                    parts.append(" ｜ ".join(hdrs))
        elif kind == "para":
            parts.append("\n".join(_plain_inline(line) for line in block[1]))
    return "\n".join(parts).strip()


def prepare_reply(raw_text, signature=""):
    text = (raw_text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return "", [], False
    blocks, use_markdown = parse_markdown_blocks(text)
    visible = markdown_plain_text(blocks) if use_markdown else text
    if text.startswith("/") or visible.lstrip().startswith("/"):
        lines = text.split("\n")
        first_non_empty = next((idx for idx, line in enumerate(lines) if line.strip()), 0)
        if use_markdown and _is_block_start(lines, first_non_empty):
            text = "AI ·\n\n" + text
        else:
            text = "AI · " + text
        blocks, use_markdown = parse_markdown_blocks(text)
    signature = signature.replace("\r\n", "\n").replace("\r", "\n").strip()
    if signature:
        if not signature.startswith("——"):
            gap = "\n\n" if _is_block_start(signature.split("\n"), 0) else " "
            signature = "——" + gap + signature
        # Parse independently so an unfinished code fence in the answer cannot swallow the footer.
        footer, rich_footer = parse_markdown_blocks(signature, linkify_urls=True)
        if not use_markdown:
            blocks = [("para", text.split("\n"))]
        blocks.extend(footer)
        text += "\n\n" + (markdown_plain_text(footer) if rich_footer else signature)
        use_markdown = use_markdown or rich_footer
    return text, blocks, use_markdown


class _RichTextBuilder:
    def __init__(self, rich, element_cls):
        self.rich = rich
        self.E = element_cls
        self.n = 0
        self.inner = []
        self.style_index = {}

    def node(self, tag, prop=b"", children=(), styles=()):
        self.n += 1
        eid = str(self.n)
        el = self.rich.elements.dictionary[eid]
        el.tag = tag
        el.property = prop
        if children:
            el.childIds.extend(children)
        els = self.rich.elements
        for name, value in dict(styles).items():
            el.style[name] = value
            if (name, value) not in self.style_index:
                self.style_index[(name, value)] = len(els.styles)
                els.styles.add(name=name, value=value)
            els.styleRefs[name].styleIds.append(self.style_index[(name, value)])
        return eid

    def text(self, s, styles=()):
        self.inner.append(s)
        return self.node(RT_TEXT, self.E.TextProperty(content=s).SerializeToString(), styles=styles)

    def inline(self, line, base_styles=()):
        ids = []
        for kind, content, url, styles in _inline_tokens(line, tuple(base_styles)):
            if kind == "url":
                prop = self.E.AnchorProperty(href=url, content=url, textContent=url)
                ids.append(self.node(RT_LINK, prop.SerializeToString(), styles=styles))
                self.inner.append(url)
            elif kind == "link":
                prop = self.E.AnchorProperty(href=url, content=content, isCustom=True, scene=RT_ANCHOR_CUSTOM)
                ids.append(self.node(RT_LINK, prop.SerializeToString(), styles=styles))
                self.inner.append(content)
            else:
                ids.append(self.text(content, styles))
        return ids

    def inline_lines(self, lines, base_styles=()):
        ids = []
        for idx, line in enumerate(lines):
            if idx:
                ids.append(self.text("\n", base_styles))
            ids.extend(self.inline(line, base_styles))
        return ids

    def end_block(self):
        if self.inner and not self.inner[-1].endswith("\n"):
            self.inner.append("\n")


def fill_markdown_rich_text(rich, blocks, element_cls):
    builder = _RichTextBuilder(rich, element_cls)
    root_children = []
    for block in blocks:
        kind = block[0]
        if kind == "code":
            lang, code = block[1], block[2]
            if code:
                builder.inner.append(code)
            prop = builder.E.CodeBlockProperty(
                language=CODE_LANGS.get(lang.lower(), DEFAULT_CODE_LANG),
                content=code + "\n",
            ).SerializeToString()
            root_children.append(builder.node(RT_CODE_BLOCK, prop))
            builder.end_block()
        elif kind == "heading":
            children = builder.inline(block[1], (RT_BOLD,))
            if children:
                root_children.append(builder.node(RT_PARA, children=children))
                builder.end_block()
        elif kind == "quote":
            paras = []
            for is_head, q_lines in block[1]:
                children = builder.inline_lines(q_lines, (RT_BOLD,) if is_head else ())
                if children:
                    paras.append(builder.node(RT_PARA, children=children))
                    builder.end_block()
            if paras:
                root_children.append(builder.node(RT_QUOTE, children=paras))
        elif kind in ("ul", "ol"):
            ordered = kind == "ol"
            items = block[2] if ordered else block[1]
            li_ids = []
            for item_lines in items:
                children = builder.inline_lines(item_lines)
                if children:
                    li_ids.append(builder.node(RT_LI, children=children))
                    builder.end_block()
            if li_ids:
                if ordered:
                    prop = builder.E.OLProperty(type=0, start=block[1]).SerializeToString()
                    root_children.append(builder.node(RT_OL, prop, children=li_ids))
                else:
                    prop = builder.E.ULProperty(type=0).SerializeToString()
                    root_children.append(builder.node(RT_UL, prop, children=li_ids))
        elif kind == "table":
            headers, rows = block[1], block[2]
            li_ids = []
            for row in rows:
                fields = _table_row_fields(headers, row)
                if not fields:
                    continue
                children = []
                for idx, (header, cell) in enumerate(fields):
                    if idx:
                        children.append(builder.text(" ｜ "))
                    if header:
                        children.extend(builder.inline(header, (RT_BOLD,)))
                        children.append(builder.text("："))
                    children.extend(builder.inline(cell))
                if children:
                    li_ids.append(builder.node(RT_LI, children=children))
                    builder.end_block()
            if li_ids:
                prop = builder.E.ULProperty(type=0).SerializeToString()
                root_children.append(builder.node(RT_UL, prop, children=li_ids))
            else:
                non_empty_headers = [h for h in headers if h]
                if non_empty_headers:
                    children = []
                    for idx, header in enumerate(non_empty_headers):
                        if idx:
                            children.append(builder.text(" ｜ ", (RT_BOLD,)))
                        children.extend(builder.inline(header, (RT_BOLD,)))
                    if children:
                        root_children.append(builder.node(RT_PARA, children=children))
                        builder.end_block()
        elif kind == "para":
            children = builder.inline_lines(block[1])
            if children:
                root_children.append(builder.node(RT_PARA, children=children))
                builder.end_block()
    if not root_children:
        return False
    rich.elementIds.append(builder.node(RT_DOCS, children=root_children))
    rich.innerText = "".join(builder.inner).strip() or " "
    rich.version = 1
    return True


def _bold_header_md(header):
    stripped = header.strip()
    if stripped.startswith("**") and stripped.endswith("**") and len(stripped) > 4:
        return stripped
    return f"**{stripped}**"


def render_normalized_markdown(blocks):
    # Older SDKs only recognize ASCII bare URLs. Explicit Markdown links keep their Unicode labels and targets.
    def portable_link(match):
        raw = match.group("url")
        if not raw or raw.isascii():
            return match[0]
        url = _trim_bare_url(raw)
        return f"[{url}]({url})" + raw[len(url):]

    out = []
    for block in blocks:
        kind = block[0]
        if kind == "code":
            lang, code = block[1], block[2]
            safe_code = "\n".join(
                ("\u200b" + line if line.strip().startswith("```") else line)
                for line in code.split("\n")
            ) if code else ""
            out.append(f"```{lang}\n{safe_code}\n```" if safe_code else f"```{lang}\n```")
        elif kind == "heading":
            out.append(f"## {block[1]}")
        elif kind == "quote":
            q_parts = []
            for is_head, q_lines in block[1]:
                for line in q_lines:
                    q_parts.append("> " + (_bold_header_md(line) if is_head else line))
            out.append("\n".join(q_parts))
        elif kind == "ul":
            out.append("\n".join("- " + " ".join(item_lines) for item_lines in block[1]))
        elif kind == "ol":
            start = block[1]
            out.append("\n".join(f"{start + idx}. " + " ".join(item_lines) for idx, item_lines in enumerate(block[2])))
        elif kind == "table":
            headers, rows = block[1], block[2]
            rendered_rows = []
            for row in rows:
                fields = _table_row_fields(headers, row)
                if not fields:
                    continue
                cells = [f"{_bold_header_md(h)}：{c}" if h else c for h, c in fields]
                rendered_rows.append("- " + " ｜ ".join(cells))
            if rendered_rows:
                out.append("\n".join(rendered_rows))
            else:
                non_empty_headers = [_bold_header_md(h) for h in headers if h]
                if non_empty_headers:
                    out.append(" ｜ ".join(non_empty_headers))
        elif kind == "para":
            out.append("\n".join(block[1]))
        if kind != "code":
            out[-1] = SDK_LINK_RE.sub(portable_link, out[-1])
    return "\n\n".join(part for part in out if part).strip()


class Channel:
    def __init__(self, client, owner, decoders, compose=None):
        self.client = client
        self.owner = owner
        self.decoders = decoders
        self.compose = compose
        self.started = int(time.time())
        self.recent_commands = OrderedDict()
        self.recent_contexts = OrderedDict()
        self.chat_names = OrderedDict()
        self.receipt_lock = threading.Lock()

    def remember_chat_name(self, chat, info):
        if not isinstance(info, dict):
            return ""
        name = info.get("name")
        if not isinstance(name, str):
            return ""
        name = " ".join(name.split())[:80]
        if not name:
            return ""
        with self.receipt_lock:
            self.chat_names[chat] = name
            self.chat_names.move_to_end(chat)
            if len(self.chat_names) > 512:
                self.chat_names.popitem(last=False)
        return name

    def cached_chat_name(self, chat):
        with self.receipt_lock:
            name = self.chat_names.get(chat, "")
            if name:
                self.chat_names.move_to_end(chat)
            return name

    def raw(self, ids):
        result = self.client.api("messages.PullMessagesByIdsRequest", {"messageIds": ids})
        return {str(item.get("id")): item for item in (result or {}).get("messages", {}).values()}

    @staticmethod
    def visible(raw, chat):
        return (str(raw.get("chatId") or raw.get("channelId") or "") == chat
                and raw.get("status", 1) in (1, "NORMAL", 3, "MODIFIED") and not raw.get("isRemoved"))

    def message_text(self, decoded):
        data = decoded.get("content_data")
        if decoded.get("msg_type") == 2 and isinstance(data, dict):
            body = self.decoders.extract_rich_text(data.get("richText") or {}) or data.get("text", "")
            return "\n".join(filter(None, [data.get("title"), body])).strip()
        return (decoded.get("content") or "").strip()

    def origin(self, raw, chat):
        if not self.visible(raw, chat) or str(raw.get("fromId")) != self.owner or identifier(raw.get("originalSenderId")):
            return None
        decoded = self.decoders.message_dict(raw)
        if decoded["msg_type"] not in (2, 4) or raw.get("fromType") in (2, "2", "BOT") or decoded.get("from_type") == 2:
            return None
        text = self.message_text(decoded)
        if not text.startswith("/") or len(text) > 32000:
            return None
        message = identifier(raw["id"])
        kind = decoded["chat_type"]
        if not message or kind not in (1, 2, 3):
            return None
        mode = raw.get("threadMessageType", 0)
        thread = ""
        chat_name = ""
        if mode in (2, "THREAD_REPLY_MESSAGE"):
            thread = identifier(raw.get("threadId"))
            if not thread:
                return None
        elif mode in (1, "THREAD_ROOT_MESSAGE") or kind == 3:
            thread = message
        elif kind == 2:
            info = self.client.get_chat_info(chat)
            if not info or not (info.get("chatMode") or info.get("type")):
                return None
            chat_name = self.remember_chat_name(chat, info)
            if self.decoders.is_thread_chat(info):
                thread = identifier(raw.get("threadId")) or message
        if not chat_name:
            chat_name = self.cached_chat_name(chat)
        parent = identifier(raw.get("parentId")) or identifier(raw.get("rootId"))
        result = {"id": message, "chat": chat, "sender": self.owner, "kind": "dm" if kind == 1 else "group",
                  "text": text, "thread": thread, "parent": parent if parent != message else "",
                  "created": int(raw.get("createTime") or 0)}
        if chat_name:
            result["chatName"] = chat_name
        return result

    def fetch_origin(self, chat, message):
        raw = self.raw([message]).get(message)
        return raw, self.origin(raw, chat) if raw else None

    def pushed_origin(self, pushed, chat, message):
        raw = pushed.get("_raw")
        if not isinstance(raw, dict) or identifier(raw.get("id")) != message:
            return self.fetch_origin(chat, message)
        origin = self.origin(raw, chat)
        if not origin:
            return raw, None
        mode = raw.get("threadMessageType", 0)
        if (origin["kind"] == "group" and origin["parent"]
                and mode not in (1, 2, "THREAD_ROOT_MESSAGE", "THREAD_REPLY_MESSAGE")):
            return self.fetch_origin(chat, message)
        return raw, origin

    async def incoming(self, pushed):
        if (str(pushed.get("from_id")) != self.owner or pushed.get("msg_type") not in (2, 4)
                or int(pushed.get("create_time") or 0) < self.started
                or not self.message_text(pushed).startswith("/")):
            return
        chat, message = identifier(pushed.get("chat_id")), identifier(pushed.get("msg_id"))
        if not chat or not message:
            return
        raw, origin = await asyncio.to_thread(self.pushed_origin, pushed, chat, message)
        if origin and origin["created"] >= self.started:
            key = (chat, message)
            now = time.monotonic()
            with self.receipt_lock:
                self.recent_commands[key] = now
                self.recent_commands.move_to_end(key)
                if len(self.recent_commands) > 128:
                    self.recent_commands.popitem(last=False)
                self.recent_contexts[key] = (now, raw, origin)
                self.recent_contexts.move_to_end(key)
                if len(self.recent_contexts) > 128:
                    self.recent_contexts.popitem(last=False)
            emit(event="message", message=origin)

    def context(self, raw, origin, limit):
        chat, thread = origin["chat"], origin["thread"]
        seen = {origin["id"]}
        lines = []

        def add(item, label, maximum=450):
            if not item or not self.visible(item, chat):
                return
            key = str(item.get("id"))
            if key in seen or int(item.get("createTime") or 0) > origin["created"]:
                return
            seen.add(key)
            decoded = self.decoders.message_dict(item)
            text = self.message_text(decoded)[:maximum]
            if text:
                lines.append({"source": label, "sender": str(decoded.get("from_id") or ""), "text": text})

        refs = list(dict.fromkeys(key for key in (origin["parent"], thread) if key and key not in seen))
        if refs:
            try:
                sources = self.raw(refs)
            except Exception:
                sources = {}
            for key in refs:
                add(sources.get(key), "引用" if key == origin["parent"] else "话题根", 2000)
        position = int(raw.get("threadPosition" if thread else "position") or 0)
        positions = list(range(max(0, position - limit), position))
        if positions:
            try:
                if thread:
                    result = self.client.api("thread.PullThreadMessagesByPositionsRequest",
                                             {"threadId": thread, "channelId": chat, "positions": positions, "onlyVisibleMessages": True})
                else:
                    result = self.client.api("messages.PullMessagesByPositionsRequest", {"chatId": chat, "positions": positions})
            except Exception:
                result = {}
            for item in sorted((result or {}).get("messages", {}).values(), key=lambda item: int(item.get("createTime") or 0)):
                item_thread = str(item.get("threadId") or "")
                if thread and item_thread != thread and str(item.get("id")) != thread:
                    continue
                if not thread and item.get("threadMessageType") in (2, "THREAD_REPLY_MESSAGE"):
                    continue
                add(item, "前文")
        return json.dumps(lines, ensure_ascii=False) if lines else ""

    def react(self, chat, message, reaction):
        with self.receipt_lock:
            verified = self.recent_commands.pop((chat, message), None)
        if verified is None or time.monotonic() - verified > 30:
            _, origin = self.fetch_origin(chat, message)
            if not origin:
                return {"status": "failed"}
        try:
            result = self.client.api("reactions.PutReactionRequest", {"messageId": message, "reactionType": reaction})
            count = int((result or {}).get("count") or 0)
        except Exception as error:
            status = getattr(getattr(error, "response", None), "status_code", 0)
            return {"status": "failed" if 400 <= status < 500 else "unknown"}
        return {"status": "ok" if count > 0 else "unknown"}

    def _send_managed_text(self, chat, message, thread, thread_chat, text):
        if thread:
            from google.protobuf.json_format import MessageToDict
            # The SDK's high-level send sets the parent to the thread root.
            request = self.compose.message_request(chat, text=text, root_id=thread, thread_chat=thread_chat)
            request.parentId = message
            result = self.client.api("messages.PutMessageRequest", MessageToDict(request, preserving_proto_field_name=True))
            return ((result or {}).get("message") or {}).get("id")
        return self.client.send_msg(text, chat)

    def _send_managed_markdown(self, chat, message, thread, thread_chat, text, blocks):
        from google.protobuf.json_format import MessageToDict
        lark_all = getattr(self.compose, "_lark_all", None)
        if lark_all is not None:
            request = self.compose.message_request(chat, text="", root_id=thread or None, thread_chat=thread_chat)
            request.type = TYPE_POST
            request.content.richText.Clear()
            if not fill_markdown_rich_text(request.content.richText, blocks, lark_all().entities.RichTextElement):
                return self._send_managed_text(chat, message, thread, thread_chat, text)
        else:
            request = self.compose.message_request(chat, markdown=render_normalized_markdown(blocks),
                                                   root_id=thread or None, thread_chat=thread_chat)
        if thread:
            request.parentId = message
        try:
            result = self.client.api("messages.PutMessageRequest", MessageToDict(request, preserving_proto_field_name=True))
        except Exception as error:
            status = getattr(getattr(error, "response", None), "status_code", 0)
            if 400 <= status < 500:
                return self._send_managed_text(chat, message, thread, thread_chat, text)
            raise
        return ((result or {}).get("message") or {}).get("id")

    def handle(self, req):
        method = req["method"]
        chat, message = identifier(req.get("chat")), identifier(req.get("message"))
        if not chat or not message:
            return {"status": "failed"}
        if method == "react":
            return self.react(chat, message, req["reaction"])
        if method == "context":
            limit = min(50, max(0, int(req.get("limit") or 0)))
            cached = None
            with self.receipt_lock:
                entry = self.recent_contexts.pop((chat, message), None)
            if entry is not None and time.monotonic() - entry[0] <= 30:
                raw, origin = entry[1], entry[2]
                pos_field = "threadPosition" if origin["thread"] else "position"
                if limit == 0 or int(raw.get(pos_field) or 0) > 0:
                    cached = (raw, origin)
            raw, origin = cached if cached is not None else self.fetch_origin(chat, message)
            if not origin:
                return {"status": "failed"}
            return {"status": "ok", "text": self.context(raw, origin, limit)}
        raw, origin = self.fetch_origin(chat, message)
        if not origin:
            return {"status": "failed"}
        if method != "reply":
            return {"status": "failed"}
        thread = req.get("thread") or ""
        if ((origin["thread"] and origin["thread"] != thread)
                or (thread and thread not in (origin["thread"], message))):
            return {"status": "failed"}
        text, blocks, use_markdown = prepare_reply(req["text"], req.get("signature", ""))
        if not text:
            return {"status": "failed"}
        try:
            if self.compose is None:  # Explicitly provided lark-twin environment.
                payload = ({"kind": "markdown", "text": render_normalized_markdown(blocks)}
                           if use_markdown else {"kind": "text", "text": text})
                answer = self.client.send_message(payload, chat, root_id=thread or None,
                                                  parent_id=message if thread else None, in_thread=bool(thread), fallback=False)
            else:
                thread_chat = False
                if thread:
                    info = self.client.get_chat_info(chat)
                    if not info or not (info.get("chatMode") or info.get("type")):
                        return {"status": "failed"}
                    thread_chat = self.decoders.is_thread_chat(info)
                if use_markdown:
                    answer = self._send_managed_markdown(chat, message, thread, thread_chat, text, blocks)
                else:
                    answer = self._send_managed_text(chat, message, thread, thread_chat, text)
        except Exception:
            return {"status": "unknown"}
        return {"status": "ok", "remoteId": str(answer)} if identifier(answer) else {"status": "unknown"}


output_lock = threading.Lock()


def emit(**fields):
    with output_lock:
        print(json.dumps(fields, ensure_ascii=False, separators=(",", ":")), flush=True)


def commands(channel):
    def respond(request):
        try:
            result = channel.handle(request)
        except Exception:
            result = {"status": "failed"}
        emit(id=request["id"], **result)

    with ThreadPoolExecutor(max_workers=4) as reads, ThreadPoolExecutor(max_workers=2) as reactions, ThreadPoolExecutor(max_workers=1) as sends:
        for line in sys.stdin:
            req = json.loads(line)
            executor = {"context": reads, "react": reactions}.get(req.get("method"), sends)
            executor.submit(respond, req)


async def listen(channel, region, expired):
    while True:
        try:
            await channel.client.connect_websocket(channel.incoming, lambda: emit(event="online", account=channel.owner, region=region))
        except expired:
            emit(event="expired")
            return
        except Exception:
            pass
        emit(event="connecting")
        await asyncio.sleep(5)


def main():
    os.umask(0o077)
    home = Path(os.environ["LEVER_CHANNEL_HOME"])
    os.environ.update(LARKX_HOME=str(home), LARKX_NO_DOTENV="1", PYTHON_DOTENV_DISABLED="1")
    try:
        from larkx import AuthExpired, LarkAuth, LarkClient, QrLogin
        if importlib.util.find_spec("larkx.protocol") is None:
            from larkx.proto import compose, decoders, gateway
            from larkx.region import get_region
        else:
            from larkx.protocol import get_region
            from larkx.protocol.proto import decoders, gateway
            compose = None
        from loguru import logger
    except ImportError:
        emit(event="dependency")
        return
    logger.remove()
    action, region = sys.argv[1:]
    auth = LarkAuth(path=home / "credentials.json")
    try:
        if action == "login":
            login = QrLogin(get_region(region))
            emit(event="qr", qr=login.qr_content)
            if not login.wait(timeout=120)[0]:
                emit(event="expired")
                return
            login.finish(auth)
        if not auth.cookies or auth.region.name != region:
            emit(event="signedOut")
            return
        client = LarkClient(auth)
        owner = identifier(auth.user_id)
        if not owner:
            emit(event="expired")
            return
        install_gateway_http(client, gateway)
        cache_chat_info(client)
        install_full_push_decoder(decoders, gateway)
        channel = Channel(client, owner, decoders, compose)
        threading.Thread(target=commands, args=(channel,), daemon=True).start()
        asyncio.run(listen(channel, region, AuthExpired))
    except AuthExpired:
        emit(event="expired")


if __name__ == "__main__":
    with contextlib.suppress(BrokenPipeError):
        main()
