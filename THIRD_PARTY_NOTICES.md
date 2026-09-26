# Audio export dependencies

Muse loads the browser audio encoder as a separate worker/WASM module. These
components retain their own licenses; Muse's project license is in LICENSE.

| Component | Installed version | License | Source |
| --- | --- | --- | --- |
| @ffmpeg/ffmpeg | 0.12.15 | MIT | [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) |
| @ffmpeg/core | 0.12.10 | GPL-2.0-or-later | [ffmpeg.wasm core releases and build sources](https://github.com/ffmpegwasm/ffmpeg.wasm/releases) |
| midi-file | 1.2.4 | MIT | [midi-file](https://github.com/carter-thaxton/midi-file) |

The encoder core includes FFmpeg and its configured codec libraries; their
licenses and build sources are maintained by the upstream ffmpeg.wasm project.
See its [license](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/LICENSE)
and [build instructions](https://ffmpegwasm.netlify.app/docs/contribution/core/).
The GPL text is available from [GNU](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html).
Exact dependency artifacts are recorded in package-lock.json.
