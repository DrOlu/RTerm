# resources/neuralos — build-time engine download

The release workflows (`Download neuralOS engine + weights` step) place the
per-OS neuralOS engine binary and the 35 MB needle3.cact weights here before
each platform compile; electron-builder ships them at `<resources>/neuralos/`
(extraResources), and the neuralos plugin resolves them there first. Nothing
in this directory is committed except this README — local builds still work
(empty dir), and the plugin falls back to the shared cache
(~/.cache/neuralos, auto-provisioned on first use) or explicit settings.

Files at build time: needle3.cact + engine-macos-arm64 | engine-linux-x86_64
| engine-linux-arm64 | engine-windows-x86_64.exe (macos-x64 has no published
engine — those installs use the cache/fallback paths).

Source: https://huggingface.co/Cactus-Compute/needle3
