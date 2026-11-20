# grok-engine

Vendored source of **Grok Build** (`grok`), the Rust agent runtime that the
minAgent desktop app embeds for its **xGrok** pane.

The desktop shell loads `xai_grok_ffi.dll` through koffi
(`apps/desktop/electron/xgrok-ipc.ts`). That DLL is the `cdylib` produced by the
`xai-grok-ffi` crate in this workspace, so the engine source travels with
minAgent to keep the FFI payload reproducible.

## Provenance

| Field | Value |
| --- | --- |
| Upstream project | Grok Build (`grok`) by SpaceXAI — https://x.ai/cli |
| Source revision | `559751fdcec02d413e4c57c8832ab275e4f44980` (see `SOURCE_REV`) |
| License | Apache License 2.0 (first-party code) — see `LICENSE` |
| Third-party notices | `THIRD-PARTY-NOTICES` |
| Vendored on | 2026-11-20 |

The copy is the upstream tree without build output. Removed: `target/`
(15.6 GB of local build artifacts) and the compiled `xai_grok_ffi.dll` /
`grok.exe` payloads. `bin/` is empty upstream in this snapshot; the DotSlash
descriptor for `protoc` is not included, so use a `protoc` from your `PATH` (or
set `PROTOC`).

## Building the FFI library

Requirements:

- Rust — the pinned toolchain in `rust-toolchain.toml` is installed by `rustup`.
- `protoc` — proto codegen needs it (`choco install protobuf` or set `PROTOC`
  to the executable).
- Visual Studio C++ build tools on Windows (MSVC target).

From this directory, on Windows x86_64:

```powershell
cargo build -p xai-grok-ffi --release
```

Then copy the payload into the desktop app, where `electron-builder` picks it up:

```powershell
Copy-Item .\target\release\xai_grok_ffi.dll ..\apps\desktop\native\xgrok\xai_grok_ffi.dll
```

The optional console binary used by the PTY fallback path is built with:

```powershell
cargo build -p xai-grok-pager-bin --release
Copy-Item .\target\release\xai-grok-pager.exe ..\apps\desktop\native\grok\grok.exe
```

Both outputs are git-ignored in minAgent because they exceed GitHub's 100 MB
per-file limit.

## Layout

- `crates/codegen/` — agent runtime, shell, pager (TUI), tools, FFI crate.
- `crates/common/` — shared protocol, tracing and tool-runtime crates.
- `crates/build/` — proto build helper.
- `prod/mc/cli-chat-proxy-types` — proxy wire types used by the client.
- `third_party/` — small vendored Rust crates.

Crate-local license and notice files stay next to the code that needs them;
`LICENSE` and `THIRD-PARTY-NOTICES` cover the workspace as a whole.
