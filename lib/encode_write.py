#!/usr/bin/env python3
"""把 UTF-8 文本按目标字符集原子写回文件。

用法:  python encode_write.py <path> <encoding> <bom:0|1>   < content(UTF-8)
输出:  ok <bytes>  或  err <message>

为什么需要它: harness 的 fs.writeText 只接受字符串（即只能写 UTF-8），
而 Windows 上大量既有文件是 GBK / UTF-16。写回时按原字符集编码，
才能既改内容又不制造"整文件乱码"。

写入是原子的: 同目录建临时文件 → os.replace 覆盖。
"""
import base64
import os
import sys
import tempfile

# 探测结果 → Python codec。utf-16-le/be 不带 BOM，需要时手动加。
CODECS = {
    'utf-8': 'utf-8',
    'utf-8-sig': 'utf-8-sig',
    'utf-16le': 'utf-16-le',
    'utf-16be': 'utf-16-be',
    'gbk': 'gbk',
    'gb18030': 'gb18030',
    'big5': 'big5',
    'latin1': 'latin-1',
}
BOMS = {'utf-16-le': b'\xff\xfe', 'utf-16-be': b'\xfe\xff'}


def main(argv):
    # 只编码模式: 读取 stdin(UTF-8) → 按目标字符集编码 → base64 打到 stdout。
    # 远程（SFTP）写回需要字节而不是本地文件，所以走这个模式。
    if len(argv) >= 2 and argv[1] == '--encode-only':
        if len(argv) < 4:
            print('usage: encode_write.py --encode-only <encoding> <bom>', file=sys.stderr)
            return 2
        encoding, want_bom = argv[2].lower(), argv[3] == '1'
        codec = CODECS.get(encoding)
        if codec is None:
            print(f'err unsupported encoding: {encoding}', file=sys.stderr)
            return 3
        text = sys.stdin.buffer.read().decode('utf-8')
        if want_bom and codec == 'utf-8':
            codec = 'utf-8-sig'
        try:
            payload = text.encode(codec)
        except UnicodeEncodeError as error:
            print(f'err 无法用 {encoding} 编码: {error}', file=sys.stderr)
            return 4
        if want_bom and codec in BOMS:
            payload = BOMS[codec] + payload
        sys.stdout.write(base64.b64encode(payload).decode('ascii'))
        return 0

    if len(argv) < 4:
        print('usage: encode_write.py <path> <encoding> <bom>', file=sys.stderr)
        return 2
    path, encoding, want_bom = argv[1], argv[2].lower(), argv[3] == '1'
    codec = CODECS.get(encoding)
    if codec is None:
        print(f'err unsupported encoding: {encoding}', file=sys.stderr)
        return 3

    text = sys.stdin.buffer.read().decode('utf-8')
    if want_bom and codec == 'utf-8':
        codec = 'utf-8-sig'
    try:
        payload = text.encode(codec)
    except UnicodeEncodeError as error:
        print(f'err 无法用 {encoding} 编码: {error}', file=sys.stderr)
        return 4
    if want_bom and codec in BOMS:
        payload = BOMS[codec] + payload

    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=directory, prefix='.dsh-enc-')
    try:
        with os.fdopen(handle, 'wb') as stream:
            stream.write(payload)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    print(f'ok {len(payload)}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
