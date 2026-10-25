#!/usr/bin/env python3
"""SFTP 侧车：用 AsyncSSH 持有一条长连接，通过 stdin/stdout 的 JSON 行协议服务请求。

为什么是"侧车"而不是"每次调用一次性连一次":
    登录 + 握手 + 认证在真实主机上通常是数百毫秒到数秒；批量文档操作会产生成百上千次
    文件读写。因此这里保持一个常驻进程与一条常驻连接，空闲超过 idle_timeout 才断开，
    进程本身继续存活，下一次请求重新连接即可。

协议（每行一个 JSON 对象）:
    请求  {"id":1,"op":"ping"}
          {"id":1,"op":"stat","path":"/x"}
          {"id":1,"op":"list","path":"/x"}
          {"id":1,"op":"read","path":"/x","max_bytes":8388608}
          {"id":1,"op":"write","path":"/x","data":"<base64>"}
          {"id":1,"op":"close"}
    响应  {"id":1,"ok":true,...}  或  {"id":1,"ok":false,"error":"...","code":"..."}

自检（无需真实主机，用于验证协议与生命周期）:
    python sftp_sidecar.py --self-test
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import subprocess
import sys
import time
from urllib.parse import urlparse

try:  # 自检模式不需要 asyncssh
    import asyncssh
except ImportError:  # pragma: no cover
    asyncssh = None

# OpenSSH 的默认身份文件顺序。AsyncSSH 在 client_keys=None 时**不会**自己去找这些文件
# （它只认显式给出的 key 或 SSH agent），而 Windows 上 SSH_AUTH_SOCK 通常未设置，
# 于是会出现"OpenSSH 能连、AsyncSSH 连不上"。这里按 OpenSSH 的默认顺序自己发现。
DEFAULT_KEY_NAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa', 'id_ed25519_sk', 'id_ecdsa_sk']


def default_client_keys():
    """返回 ~/.ssh 下存在的默认私钥文件（按 OpenSSH 的偏好顺序）。"""
    ssh_dir = os.path.expanduser('~/.ssh')
    return [os.path.join(ssh_dir, name) for name in DEFAULT_KEY_NAMES if os.path.isfile(os.path.join(ssh_dir, name))]


def ensure_asyncssh(auto_install, index_url, simulate_missing=False):
    """确保 asyncssh 可用；缺失时按镜像自动安装。

    为什么不在包里 vendor asyncssh：它依赖 `cryptography`，后者是**带编译产物的平台绑定包**
    （.pyd + OpenSSL DLL，约 10MB、按平台/架构分轮子）。把平台二进制塞进 agent 插件会随平台腐烂；
    而一次镜像安装实测约 2 秒，所以这里选择"自动装"而不是"打包带"。

    :returns: (可用?, 说明文本)
    """
    global asyncssh
    if simulate_missing:
        asyncssh = None
        return False, '模拟缺失（测试用）'
    if asyncssh is not None:
        return True, 'asyncssh 已就绪'
    if not auto_install:
        return False, 'asyncssh 未安装，且已关闭自动安装'
    command = [sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input']
    if index_url:
        command += ['--index-url', index_url]
        host = urlparse(index_url).hostname
        if host:
            command += ['--trusted-host', host]
    command.append('asyncssh')
    print(f'[sidecar] installing asyncssh via {index_url or "default index"} …', file=sys.stderr, flush=True)
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=900, check=False)
    except Exception as error:  # noqa: BLE001
        return False, f'自动安装 asyncssh 失败：{type(error).__name__}: {error}'
    tail = (completed.stdout or '')[-800:] + (completed.stderr or '')[-800:]
    print(f'[sidecar] pip exit={completed.returncode}\n{tail}', file=sys.stderr, flush=True)
    if completed.returncode != 0:
        return False, f'自动安装 asyncssh 失败（pip 退出码 {completed.returncode}）'
    try:
        import importlib
        importlib.invalidate_caches()
        import asyncssh as installed  # noqa: F401
        asyncssh = installed
        return True, 'asyncssh 已自动安装'
    except ImportError as error:
        return False, f'安装后仍无法导入 asyncssh：{error}'


class FakeBackend:
    """自检后端：内存文件系统，语义与真实后端一致。"""

    def __init__(self):
        self.files = {'/readme.md': b'# hello\n\xe4\xb8\xad\xe6\x96\x87\n'}
        self.dirs = {'/': None, '/sub': None}
        self.connected = False
        self.logins = 0

    async def connect(self):
        if not self.connected:
            self.logins += 1
            await asyncio.sleep(0.01)
            self.connected = True

    async def close(self):
        self.connected = False

    async def stat(self, path):
        if path in self.files:
            return {'type': 'file', 'size': len(self.files[path]), 'mtime': int(time.time())}
        if path in self.dirs or path == '/':
            return {'type': 'dir', 'size': None, 'mtime': int(time.time())}
        return None

    async def list(self, path):
        prefix = path.rstrip('/') + '/'
        names = {}
        for candidate in list(self.files) + list(self.dirs):
            if not candidate.startswith(prefix) or candidate == path:
                continue
            rest = candidate[len(prefix):]
            if rest == '':
                continue
            head, _, tail = rest.partition('/')
            names[head] = 'dir' if tail or candidate in self.dirs else 'file'
        entries = []
        for name, kind in sorted(names.items()):
            full = prefix + name
            size = len(self.files[full]) if kind == 'file' and full in self.files else None
            entries.append({'name': name, 'type': kind, 'size': size})
        return entries

    async def read(self, path, max_bytes):
        if path not in self.files:
            raise FileNotFoundError(path)
        data = self.files[path]
        if len(data) > max_bytes:
            raise ValueError(f'file exceeds max_bytes ({len(data)} > {max_bytes})')
        return data

    async def read_range(self, path, offset, length):
        if path not in self.files:
            raise FileNotFoundError(path)
        return self.files[path][offset:offset + length]

    async def write(self, path, data):
        self.files[path] = data
        # 两张表必须一致：写入隐含出来的祖先目录也要能 stat/list。
        # 否则 list('/') 会把 `/data` 当目录列出来（因为 `/data/hello.txt` 有它做前缀），
        # 而 stat('/data') 在 files/dirs 里都找不到 → 工具报"路径不存在"，
        # list_dir('/data')/read('/data') 因此都不通，只有 `/data/hello.txt` 能读。
        parent = os.path.dirname(path.rstrip('/'))
        while parent and parent != '/' and parent not in self.dirs:
            self.dirs[parent] = None
            parent = os.path.dirname(parent)
        return len(data)


class SftpBackend:
    """AsyncSSH 后端：一条常驻连接，keepalive 保活。"""

    def __init__(self, options):
        self.options = options
        self.conn = None
        self.sftp = None
        self.logins = 0
        self.last_use = 0.0

    def _password(self):
        name = self.options.password_env
        if not name:
            return None
        value = os.environ.get(name)
        if value is None:
            raise RuntimeError(f'环境变量 {name} 未设置（用于 SFTP 密码）')
        return value

    async def connect(self):
        if self.sftp is not None:
            return
        if asyncssh is None:
            raise RuntimeError('asyncssh 不可用：自动安装失败或被关闭。可运行 env_setup({pip_packages:["asyncssh"]})，或手动 pip install asyncssh')
        options = self.options
        keys = [options.key] if options.key else default_client_keys()
        print(f'[sidecar] client_keys: {keys or "(无；只尝试 SSH agent)"}', file=sys.stderr, flush=True)
        self.conn = await asyncssh.connect(
            options.host,
            port=options.port,
            username=options.user,
            client_keys=keys or None,
            password=self._password(),
            known_hosts=options.known_hosts if options.known_hosts else None,
            keepalive_interval=30,
            keepalive_count_max=3,
            login_timeout=20,
        )
        self.sftp = await self.conn.start_sftp_client()
        self.logins += 1
        self.last_use = time.time()

    async def close(self):
        try:
            if self.sftp is not None:
                self.sftp.exit()
        except Exception:
            pass
        self.sftp = None
        if self.conn is not None:
            try:
                self.conn.close()
                await self.conn.wait_closed()
            except Exception:
                pass
        self.conn = None

    def _full(self, path):
        root = self.options.root or ''
        if root and not path.startswith(root):
            return root.rstrip('/') + '/' + path.lstrip('/')
        return path

    async def stat(self, path):
        await self.connect()
        full = self._full(path)
        try:
            info = await self.sftp.stat(full)
        except (FileNotFoundError, PermissionError):
            return None
        kind = 'dir' if info.type == asyncssh.FILEXFER_TYPE_DIRECTORY else ('file' if info.type == asyncssh.FILEXFER_TYPE_REGULAR else 'other')
        return {'type': kind, 'size': info.size, 'mtime': int(info.mtime or 0)}

    async def list(self, path):
        await self.connect()
        entries = []
        for entry in sorted(await self.sftp.readdir(self._full(path)), key=lambda item: item.filename):
            name = entry.filename
            if name in ('.', '..'):
                continue
            kind = 'dir' if entry.attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY else ('file' if entry.attrs.type == asyncssh.FILEXFER_TYPE_REGULAR else 'other')
            entries.append({'name': name, 'type': kind, 'size': entry.attrs.size})
        return entries

    async def read(self, path, max_bytes):
        await self.connect()
        full = self._full(path)
        info = await self.sftp.stat(full)
        if info.size is not None and info.size > max_bytes:
            raise ValueError(f'file exceeds max_bytes ({info.size} > {max_bytes})')
        async with self.sftp.open(full, 'rb') as handle:
            return await handle.read()

    async def read_range(self, path, offset, length):
        await self.connect()
        async with self.sftp.open(self._full(path), 'rb') as handle:
            await handle.seek(offset)
            return await handle.read(length)

    async def write(self, path, data):
        await self.connect()
        full = self._full(path)
        parent = os.path.dirname(full)
        if parent:
            try:
                await self.sftp.makedirs(parent, exist_ok=True)
            except Exception:
                pass
        async with self.sftp.open(full, 'wb') as handle:
            await handle.write(data)
        return len(data)


async def serve(backend, idle_timeout):
    writer = sys.stdout

    async def idle_watchdog():
        while True:
            await asyncio.sleep(5)
            connected = backend.connected if isinstance(backend, FakeBackend) else backend.sftp is not None
            if connected and time.time() - backend.last_use > idle_timeout:
                await backend.close()

    watchdog = asyncio.create_task(idle_watchdog())
    try:
        while True:
            # Windows 的 Proactor loop 不支持 connect_read_pipe(stdin)（WinError 6），
            # 因此把阻塞的 readline 放到工作线程里跑——跨平台一致。
            line = await asyncio.to_thread(sys.stdin.buffer.readline)
            if not line:
                break
            try:
                request = json.loads(line.decode('utf-8'))
            except json.JSONDecodeError as error:
                writer.write(json.dumps({'id': None, 'ok': False, 'error': f'bad json: {error}'}) + '\n')
                writer.flush()
                continue
            response = await handle(backend, request)
            backend.last_use = time.time()
            writer.write(json.dumps(response) + '\n')
            writer.flush()
            if request.get('op') == 'shutdown':
                break
    finally:
        watchdog.cancel()
        await backend.close()


async def handle(backend, request):
    request_id = request.get('id')
    op = request.get('op')
    if not isinstance(backend, FakeBackend) and asyncssh is None:
        return {
            'id': request_id,
            'ok': False,
            'code': 'MISSING_DEP',
            'error': 'asyncssh 不可用（自动安装失败或被关闭）。可运行 env_setup({pip_packages:["asyncssh"]})，或手动 pip install asyncssh'
        }
    try:
        if op == 'ping':
            # ping 就是"验证凭据"：真的去建立连接（失败会走下面的异常分支返回错误）
            await backend.connect()
            connected = backend.connected if isinstance(backend, FakeBackend) else backend.sftp is not None
            return {'id': request_id, 'ok': True, 'pong': True, 'connected': bool(connected), 'logins': backend.logins}
        if op == 'stat':
            info = await backend.stat(request['path'])
            return {'id': request_id, 'ok': True, 'info': info}
        if op == 'list':
            return {'id': request_id, 'ok': True, 'entries': await backend.list(request.get('path') or '/')}
        if op == 'read':
            if request.get('length') is not None:
                data = await backend.read_range(request['path'], int(request.get('offset') or 0), int(request['length']))
                return {'id': request_id, 'ok': True, 'data': base64.b64encode(data).decode('ascii'), 'size': len(data)}
            data = await backend.read(request['path'], int(request.get('max_bytes') or 8 * 1024 * 1024))
            return {'id': request_id, 'ok': True, 'data': base64.b64encode(data).decode('ascii'), 'size': len(data)}
        if op == 'write':
            payload = base64.b64decode(request.get('data') or '')
            written = await backend.write(request['path'], payload)
            return {'id': request_id, 'ok': True, 'bytes': written}
        if op == 'close':
            await backend.close()
            return {'id': request_id, 'ok': True, 'closed': True}
        if op == 'shutdown':
            return {'id': request_id, 'ok': True, 'shutdown': True}
        return {'id': request_id, 'ok': False, 'error': f'unknown op: {op}', 'code': 'BAD_OP'}
    except FileNotFoundError as error:
        return {'id': request_id, 'ok': False, 'error': f'no such file: {error}', 'code': 'NOT_FOUND'}
    except Exception as error:  # noqa: BLE001 - 协议层必须把所有异常变成响应
        return {'id': request_id, 'ok': False, 'error': f'{type(error).__name__}: {error}', 'code': 'FAILED'}


def main(argv=None):
    parser = argparse.ArgumentParser(description='SFTP sidecar for dsh-doc-pipeline')
    parser.add_argument('--host')
    parser.add_argument('--port', type=int, default=22)
    parser.add_argument('--user')
    parser.add_argument('--key')
    parser.add_argument('--password-env')
    parser.add_argument('--known-hosts')
    parser.add_argument('--root')
    parser.add_argument('--idle-timeout', type=float, default=900.0)
    parser.add_argument('--auto-install', type=int, default=1, help='asyncssh 缺失时是否自动按镜像安装（1/0）')
    parser.add_argument('--pip-index-url', help='pip 镜像地址；省略则用环境变量 PIP_INDEX_URL')
    parser.add_argument('--simulate-missing-dep', action='store_true', help='测试用：强制当作 asyncssh 缺失')
    parser.add_argument('--self-test', action='store_true')
    options = parser.parse_args(argv)
    if not options.self_test:
        ready, note = ensure_asyncssh(
            options.auto_install == 1,
            options.pip_index_url or os.environ.get('PIP_INDEX_URL'),
            options.simulate_missing_dep
        )
        print(f'[sidecar] asyncssh: {"ok" if ready else "unavailable"} — {note}', file=sys.stderr, flush=True)
    backend = FakeBackend() if options.self_test else SftpBackend(options)
    try:
        asyncio.run(serve(backend, options.idle_timeout))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
