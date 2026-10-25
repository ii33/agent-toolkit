# test/fixtures

出货文件快照，供离线测试使用。

## 为什么需要

DSH Desktop 把装机包放在 `resources/app.asar` 内。asar 对普通 `node` 是一个**普通文件**，
读不进去，所以 `test/` 里"用真实出货预设当样本"的用例在离线时拿不到源文件。
本目录保存这些文件的**逐字节快照**，让同一批断言在没有安装目录的机器上也能跑。

## 回落顺序

`test/deps.mjs` 的 `resolveShippedFile()`：

1. `$DSH_SHIPPED_MODULES` —— 直接指向装机包的 `node_modules`；
2. `$DSH_APP_ROOT/node_modules` —— 指向解包安装目录；
3. `test/fixtures/<basename>` —— 本目录快照（测试会打印 `source: fixture`）。

## 快照清单

| 文件 | 来源 | 版本 |
|---|---|---|
| `standard.patch.yml` | `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` | 0.2.1-rc.2 |

## 刷新

升级 DSH 后，从新安装里重新取一份覆盖同名文件，并更新上表的版本号：

```
D:\a\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-web-app\presets\standard.patch.yml
```

（asar 内的路径只能用 DSH 自己的文件读取能力读，shell / node 都不行。）
