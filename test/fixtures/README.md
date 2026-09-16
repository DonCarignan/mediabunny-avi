`opendml.avi` is `seed_odml_tiny_segments.avi` from OxideAV/oxideav-avi. It contains two RIFF segments and is
covered by the accompanying MIT license in `LICENSE.OxideAV`.

Source: https://github.com/OxideAV/oxideav-avi/blob/90e2f6a5e798872916b0f0ab32e7e8385632d0e5/fuzz/corpus/demux/seed_odml_tiny_segments.avi

Other regression fixtures are constructed from AVI structures in the test file.

`avc-pcm.avi` is one second of AVC video (25 frames, keyframe every 5, no B-frames) with 8 kHz mono PCM audio,
generated with FFmpeg 8.0:

```sh
ffmpeg -f lavfi -i testsrc=size=64x64:rate=25:duration=1 -f lavfi -i sine=frequency=440:sample_rate=8000:duration=1 \
	-c:v libx264 -preset ultrafast -bf 0 -g 5 -pix_fmt yuv420p -c:a pcm_s16le -ac 1 avc-pcm.avi
```

`mpeg4-mp3.avi` is the same second with the codecs a typical AVI carries, MPEG-4 Part 2 (FourCC `FMP4`,
keyframe every 5, no B-frames) and 16 kHz mono MP3, generated with FFmpeg 8.0:

```sh
ffmpeg -f lavfi -i testsrc=size=64x64:rate=25:duration=1 -f lavfi -i sine=frequency=440:sample_rate=16000:duration=1 \
	-c:v mpeg4 -bf 0 -g 5 -q:v 4 -c:a libmp3lame -ac 1 -b:a 32k mpeg4-mp3.avi
```
