# Optional bundled FFmpeg binaries

Place platform-specific FFmpeg executable files here before packaging if you want MMCC to ship with FFmpeg.

Expected executable names:

- macOS / Linux: `ffmpeg`
- Windows: `ffmpeg.exe`

When packaged with electron-builder, this folder is copied to `process.resourcesPath/bin`. MMCC checks this location before falling back to the system `ffmpeg` in PATH.

Do not commit large binaries unless you intentionally want the repository to carry them. For normal source releases, leave this folder without actual binaries.
