/**
 * 外部程序 argv 构造（纯函数）：把"模型可能写错的那部分"固定在工具里。
 *
 * 这些函数只负责拼 argv，不执行任何东西，因此可以单独自测。
 * 设计前提：一律不经过 shell，所以不需要任何引号/转义处理。
 *
 * @module @local/dsh-doc-pipeline/argv
 */

/** pip 镜像：清华 TUNA（实测 2.2s，比官方源快一个数量级）。 */
export const DEFAULT_PIP_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple'

/** 镜像主机名，用于 pip 的 trusted-host。 */
export function mirrorHost(indexUrl) {
  try {
    return new URL(indexUrl).host
  } catch {
    return undefined
  }
}

/**
 * 构造 `python -m pip install` 的 argv。
 * @param {object} options - 选项。
 * @param {readonly string[]} options.packages - 要安装的包（可带版本约束）。
 * @param {string} options.indexUrl - 镜像地址。
 * @param {boolean} [options.upgrade] - 是否加 --upgrade。
 * @param {boolean} [options.user] - 是否加 --user（无管理员权限时有用）。
 * @returns {string[]} argv（不含可执行文件本身）。
 */
export function pipInstallArgv({ packages, indexUrl, upgrade = false, user = false }) {
  const argv = ['-m', 'pip', 'install', '--index-url', indexUrl, '--disable-pip-version-check', '--no-input']
  const host = mirrorHost(indexUrl)
  if (host !== undefined) argv.push('--trusted-host', host)
  if (upgrade) argv.push('--upgrade')
  if (user) argv.push('--user')
  argv.push(...packages)
  return argv
}

/**
 * 构造 `pip show` 的 argv（用于安装后校验）。
 * @param {readonly string[]} packages - 要查询的包。
 * @returns {string[]} argv。
 */
export function pipShowArgv(packages) {
  return ['-m', 'pip', 'show', ...packages]
}

/**
 * 构造 tar 打包 argv（bsdtar 用 -a 按扩展名自动选格式）。
 * @param {object} options - 选项。
 * @param {string} options.output - 输出归档路径（.zip / .tar.gz / .tgz）。
 * @param {string} options.dir - 归档内条目的相对基准目录。
 * @param {readonly string[]} options.items - 要打包的条目（相对 dir）。
 * @returns {string[]} argv。
 */
export function tarPackArgv({ output, dir, items }) {
  return ['-a', '-c', '-f', output, '-C', dir, ...items]
}

/**
 * 构造 docling 转换 argv。
 * @param {object} options - 选项。
 * @param {string} options.input - 输入文件。
 * @param {string} options.outDir - 输出目录。
 * @param {string} [options.to] - 目标格式（md / json / text / html）。
 * @returns {string[]} argv。
 */
export function doclingArgv({ input, outDir, to }) {
  const argv = [input, '--output', outDir]
  if (to !== undefined) argv.push('--to', to)
  return argv
}
