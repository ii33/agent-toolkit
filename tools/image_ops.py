#!/usr/bin/env python3
"""图片操作侧车：info / crop / resize。**不预设环境已配好** —— 缺 Pillow 时按镜像自动安装。

协议（一次请求一次响应，与 sftp_sidecar 的 JSON 行风格一致）：
    stdin : 一行 JSON 请求
    stdout: 一行 JSON 响应

请求字段：
    {"op":"info",   "data_b64":"...", "name":"a.png"}
    {"op":"crop",   "data_b64":"...", "box":[l,t,r,b], "out":"C:/x.png"}
    {"op":"resize", "data_b64":"...", "max_side":2048, "quality":85, "out":"C:/x.jpg"}
    （也可以用 "path" 代替 "data_b64"，让本程序自己读文件）

响应：
    {"ok":true,"width":…,"height":…,"format":"PNG","mode":"RGB","bytes":…,
     "has_alpha":false,"orientation":1,"data_b64":"…","out":"…"}
    {"ok":false,"error":"…","code":"MISSING_DEP"}   # 缺依赖且无法自动安装

用法：
    echo '{"op":"info","path":"a.png"}' | python image_ops.py --auto-install
    python image_ops.py --self-test
"""
import argparse
import base64
import io
import json
import subprocess
import sys
from urllib.parse import urlparse

MAX_INPUT_BYTES = 64 * 1024 * 1024


def ensure_pillow(auto_install: bool, index_url: str | None) -> str | None:
    """确保 Pillow 可用；返回错误说明（None 表示可用）。"""
    try:
        import PIL  # noqa: F401
        return None
    except Exception:
        if not auto_install:
            return 'Pillow 未安装，且已关闭自动安装（请用 env_setup({pip_packages:["pillow"]}) 安装）'
    command = [sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'pillow']
    if index_url:
        command += ['--index-url', index_url]
        host = urlparse(index_url).hostname
        if host:
            command += ['--trusted-host', host]
    print(f'[image_ops] installing pillow via {index_url or "default index"} …', file=sys.stderr, flush=True)
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=900, check=False)
    except Exception as problem:  # noqa: BLE001
        return f'自动安装 Pillow 失败：{problem}'
    if done.returncode != 0:
        tail = (done.stderr or done.stdout or '')[-400:]
        return f'自动安装 Pillow 失败（退出码 {done.returncode}）：{tail}'
    try:
        import PIL  # noqa: F401
    except Exception as problem:  # noqa: BLE001
        return f'安装后仍无法导入 Pillow：{problem}'
    return None


def read_source(request: dict):
    """从 data_b64 或 path 读入字节。"""
    from PIL import Image  # noqa: F401

    if isinstance(request.get('data_b64'), str) and request['data_b64'] != '':
        return base64.b64decode(request['data_b64'])
    path = request.get('path')
    if not isinstance(path, str) or path == '':
        raise ValueError('请求需要 data_b64 或 path')
    with open(path, 'rb') as handle:
        data = handle.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise ValueError(f'输入超过 {MAX_INPUT_BYTES} 字节上限')
    return data


def describe(image, data: bytes) -> dict:
    """公共元信息。"""
    return {
        'width': image.width,
        'height': image.height,
        'format': image.format,
        'mode': image.mode,
        'bytes': len(data),
        'has_alpha': image.mode in ('RGBA', 'LA', 'PA') or 'transparency' in image.info,
    }


def exif_orientation(image) -> int:
    """读 EXIF 方向（1 = 正常）。"""
    try:
        exif = image.getexif()
        value = exif.get(274)
        return int(value) if value is not None else 1
    except Exception:  # noqa: BLE001
        return 1


def encode(image, request: dict, fallback_format: str) -> tuple[bytes, str]:
    """按请求编码；保持原格式，除非显式指定。"""
    wanted = request.get('format')
    fmt = (wanted or fallback_format or 'PNG').upper()
    if fmt in ('JPG', 'JPEG'):
        fmt = 'JPEG'
        if image.mode not in ('RGB', 'L'):
            image = image.convert('RGB')
    elif fmt == 'PNG':
        if image.mode == 'P':
            image = image.convert('RGBA')
    buffer = io.BytesIO()
    quality = int(request.get('quality') or 90)
    if fmt in ('JPEG', 'WEBP'):
        image.save(buffer, format=fmt, quality=quality, method=6 if fmt == 'WEBP' else None)
    else:
        image.save(buffer, format=fmt)
    return buffer.getvalue(), fmt


def handle(request: dict) -> dict:
    from PIL import Image, ImageOps

    operation = request.get('op')
    data = read_source(request)
    image = Image.open(io.BytesIO(data))
    original_format = image.format
    # 统一按 EXIF 方向摆正，避免"裁出来的方向和看到的不一致"
    image = ImageOps.exif_transpose(image)

    if operation == 'info':
        # `ImageOps.exif_transpose` 返回**新对象**，`.format` 会变成 None（上面已经先存进 original_format），
        # 所以 info 必须用 original_format —— 否则 image_info 永远报 "unknown"。
        result = {'ok': True, **describe(image, data), 'format': original_format}
        result['orientation'] = exif_orientation(image)
        return result

    if operation == 'crop':
        box = request.get('box')
        if not isinstance(box, list) or len(box) != 4:
            raise ValueError('crop 需要 box = [left, top, right, bottom]（像素）')
        left, top, right, bottom = (int(round(float(value))) for value in box)
        left = max(0, min(left, image.width - 1))
        top = max(0, min(top, image.height - 1))
        right = max(left + 1, min(right, image.width))
        bottom = max(top + 1, min(bottom, image.height))
        image = image.crop((left, top, right, bottom))
    elif operation == 'resize':
        max_side = request.get('max_side')
        width = request.get('width')
        height = request.get('height')
        if max_side is not None:
            limit = int(max_side)
            scale = min(1.0, limit / max(image.width, image.height))
            width = max(1, int(round(image.width * scale)))
            height = max(1, int(round(image.height * scale)))
        if width is None and height is None:
            raise ValueError('resize 需要 max_side 或 width/height')
        if width is None:
            width = max(1, int(round(image.width * (int(height) / image.height))))
        if height is None:
            height = max(1, int(round(image.height * (int(width) / image.width))))
        image = image.resize((int(width), int(height)), Image.LANCZOS)
    else:
        raise ValueError(f'未知操作：{operation}')

    encoded, fmt = encode(image, request, original_format)
    out_path = request.get('out')
    result = {'ok': True, **describe(image, encoded), 'format': fmt}
    if isinstance(out_path, str) and out_path != '':
        with open(out_path, 'wb') as handle_out:
            handle_out.write(encoded)
        result['out'] = out_path
    else:
        result['data_b64'] = base64.b64encode(encoded).decode('ascii')
    return result


def self_test() -> int:
    """内置自检：造图 → info → crop → resize，全在内存里。"""
    from PIL import Image

    buffer = io.BytesIO()
    Image.new('RGB', (200, 100), (10, 20, 30)).save(buffer, format='PNG')
    payload = base64.b64encode(buffer.getvalue()).decode('ascii')

    info = handle({'op': 'info', 'data_b64': payload})
    assert info['width'] == 200 and info['height'] == 100, info

    cropped = handle({'op': 'crop', 'data_b64': payload, 'box': [10, 10, 110, 60]})
    assert cropped['width'] == 100 and cropped['height'] == 50, cropped

    resized = handle({'op': 'resize', 'data_b64': payload, 'max_side': 50})
    assert resized['width'] == 50 and resized['height'] == 25, resized

    print('[image_ops] self-test ok', file=sys.stderr, flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--auto-install', action='store_true')
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--index-url', default=None)
    args, _unknown = parser.parse_known_args()

    problem = ensure_pillow(args.auto_install, args.index_url or None)
    if problem is not None:
        json.dump({'ok': False, 'error': problem, 'code': 'MISSING_DEP'}, sys.stdout)
        sys.stdout.write('\n')
        sys.stdout.flush()
        return 3

    if args.self_test:
        return self_test()

    try:
        raw = sys.stdin.read()
        request = json.loads(raw) if raw.strip() else {}
    except Exception as problem:  # noqa: BLE001
        json.dump({'ok': False, 'error': f'请求不是合法 JSON：{problem}'}, sys.stdout)
        sys.stdout.write('\n')
        sys.stdout.flush()
        return 2

    try:
        result = handle(request)
    except Exception as problem:  # noqa: BLE001
        json.dump({'ok': False, 'error': f'{type(problem).__name__}: {problem}'}, sys.stdout)
        sys.stdout.write('\n')
        sys.stdout.flush()
        return 1

    json.dump(result, sys.stdout)
    sys.stdout.write('\n')
    sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
