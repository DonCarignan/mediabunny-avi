# Limitations

What this package will not do, and what it costs you when it does work.

## Track enumeration reads the whole video stream

For AVC and MPEG-4 Part 2, `getTracks()` reads the entire video stream to find keyframes and reject B-frames, even when an index exists. With a URL source this can download the whole video before track enumeration finishes. Metadata-only packet requests do not avoid this initial scan.

## Video that cannot be described honestly is dropped

B-frame video, DV Type-1 streams and AVC data partitions are not supported. A video track carrying any of them is dropped rather than failing the file: the file still opens, and its audio and metadata tags are still read. The drop is silent, because an extension has no warning channel.

Timed OpenDML indexes are ignored; such files are scanned instead.

## What a defect costs

A defect inside a chunk costs at most that chunk. Junk between MP3 frames is stepped over a byte at a time, a codec frame or sample frame left incomplete at the end of a stream is dropped, and a malformed NAL unit is left to the decoder to reject.

A defect in the container costs more: truncated packet data, a chunk that runs past its list, and an index that is required but unusable are all rejected outright.

## Codecs

The package identifies AVC, ProRes and MPEG-4 Part 2 video, and PCM, A-law, µ-law and MP3 audio. Every other codec is reported with codec `null` and its container identifier preserved, so you can see what a file holds without being able to decode it. Notably absent are MJPEG, uncompressed RGB and grayscale, which older capture software often writes.

The package ships no decoders. Decoding MPEG-4 Part 2 in a browser needs a custom decoder registered with Mediabunny, which is separate work that has not been done.
