#!/usr/bin/env python3
# serve.py —— 只读静态服务（**多线程**），给基站与她的页面用。
#
# ★ 为什么不用 `python3 -m http.server`：
#   这台机器是 Python **3.6**，那里的 `http.server` 还是**单线程**（3.7 才默认线程版）。
#   而现实里会同时来好几路请求：用户浏览器、她自己 `shot.sh` 跑的 chromium（一次要拿
#   html + css + 内联资源）、基站 timer。单线程会把它们排队 ——
#   2026-10-18 实测到 `Recv-Q 6`，并出现**间歇性连不上**（curl 返回 000）。
#
# ★ 为什么不用 `SimpleHTTPRequestHandler(directory=...)`：
#   那个参数也是 **3.7 才有**的。在 3.6 上传了它 ⇒ 每个连接都抛 TypeError ⇒ 全部 000
#   （这个坑 2026-10-18 真机踩过一次）。这里用 `os.chdir` 定根目录，3.6 可用。
#
# ★ 安全边界（一条都不放松）：
#   - 只 serve 一个目录（`PREVIEW_ROOT`，默认 /srv/alysia-preview）
#   - **只读**：不实现 PUT/POST/DELETE（SimpleHTTPRequestHandler 本来就只有 GET/HEAD）
#   - **不出目录**：标准库的 translate_path 会规范化 `..`；再用 realpath 兜一次
#   - **不给目录列表**（覆盖 list_directory → 404）
import os
import sys
from http.server import SimpleHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

ROOT = os.path.realpath(os.environ.get('PREVIEW_ROOT', '/srv/alysia-preview'))
PORT = int(os.environ.get('PREVIEW_PORT', '3389'))


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # 安静：只记 4xx/5xx
        code = str(args[1]) if len(args) > 1 else ''
        if code[:1] in ('4', '5'):
            sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def list_directory(self, path):
        self.send_error(404, 'Not Found')
        return None

    def translate_path(self, path):
        # 标准库已规范化 `..`（这是防越狱的主防线）。
        # ⚠️ 这里**只做词法校验**（`abspath`，不解析符号链接）：
        #   `p/<项目>` 本来就是指向各工作区的**符号链接**，用 `realpath` 会把它判成"越狱"，
        #   导致所有项目页都回落成基站首页（2026-10-18 真机踩过：16224B 变成 2455B）。
        p = super().translate_path(path)
        lex = os.path.abspath(p)
        if not (lex == ROOT or lex.startswith(ROOT + os.sep)):
            return ROOT  # 词法上就出界 ⇒ 落到根（404）
        return p


class Threaded(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    if not os.path.isdir(ROOT):
        sys.stderr.write('root 不存在：%s\n' % ROOT)
        raise SystemExit(1)
    os.chdir(ROOT)  # ★ 3.6 没有 directory= 参数，靠 cwd 定根
    srv = Threaded(('0.0.0.0', PORT), Handler)
    sys.stderr.write('preview server: %s on 0.0.0.0:%d (threaded, python %s)\n'
                     % (ROOT, PORT, sys.version.split()[0]))
    srv.serve_forever()


if __name__ == '__main__':
    main()
