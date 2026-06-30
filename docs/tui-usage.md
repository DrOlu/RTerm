# Deprecated CLI/TUI (`gyll`)

`gyll` is deprecated and unsupported.

Desktop packages no longer bundle the CLI/TUI runtime, no longer install `gyll` or `gyll-tui` launchers, and no longer edit shell profiles. New desktop installs do not include `gyll`.

When a user upgrades from an older desktop version that auto-installed `gyll`, the new desktop app removes legacy desktop-managed launcher files on startup. Existing shell profile PATH blocks are intentionally left untouched, so a stale PATH entry may remain while the `gyll` command itself fails.

## 中文

`gyll` 已废弃且不再提供支持。

桌面安装包不再内置 CLI/TUI 运行时，不再安装 `gyll` 或 `gyll-tui` launcher，也不再修改 shell profiles。新安装桌面版不会包含 `gyll`。

从旧版本升级的用户，启动新版桌面端时会清理旧版自动生成的 launcher 文件。已有 shell profile PATH block 会被保留，因此可能仍有旧 PATH 记录，但 `gyll` 命令本身应失败。
