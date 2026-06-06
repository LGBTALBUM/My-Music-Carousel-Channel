# Build / Packaging Guide

MMCC is an Electron app and can be packaged with `electron-builder`.

## Install dependencies

```bash
npm install --no-audit --no-fund
```

On macOS / Apple Silicon, if Electron download is unstable, use:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install --no-audit --no-fund --foreground-scripts
```

## Run in development

```bash
npm start
```

## Package locally

```bash
npm run pack
```

## Build distributables

macOS:

```bash
npm run dist:mac
```

Windows:

```powershell
npm run dist:win
```

Linux:

```bash
npm run dist:linux
```

Artifacts are written to `dist/`.

## DATA directory

`data/` is intentionally excluded from packaged apps. MMCC stores the runtime DATA library in an external directory. The default is `/MMCCDB/DATA`; if the app cannot write there, it falls back to `~/MMCCDB/DATA`. The path can also be changed in the app settings.

## FFmpeg

MMCC can use system FFmpeg from PATH, a path set in app settings, or a bundled binary placed under `resources/bin/` before packaging.

Expected names:

- `resources/bin/ffmpeg` on macOS / Linux
- `resources/bin/ffmpeg.exe` on Windows

## Notes

- Build macOS packages on macOS.
- Build Windows packages on Windows for the most reliable result.
- Build Linux packages on Linux for the most reliable result.
- Official distribution on macOS usually requires code signing and notarization.
- Official distribution on Windows usually benefits from code signing.
