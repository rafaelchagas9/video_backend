# Edit and conversion reliability

## September 2026 freeze investigation

Video 5343, edited from 5333, contained no video packets between 568.283 and
1751.680 seconds. Audio continued normally, so FFmpeg exited successfully and
stream/container duration checks accepted the file. The reported bitrate drop
was largely missing video, rather than a changed encoding profile.

On the installed FFmpeg n9.0.1, the decoder scheduler can buffer packets for a
blocked stream in an automatically growing FIFO. Its 1 MiB allocation limit
holds 131,072 pointers. Exceeding that limit returns ENOSPC, which the decoder
path treats as EOF and ultimately reports as success. Both hardware and software
decoding reproduced this failure; changing `thread_queue_size` did not fix it.

Primary implementation references:

- [Versioned decoder scheduler](https://github.com/FFmpeg/FFmpeg/blob/n9.0.1/fftools/ffmpeg_sched.c)
- [Decoder input and EOF handling](https://github.com/FFmpeg/FFmpeg/blob/n9.0.1/fftools/ffmpeg_dec.c#L924)
- [FIFO allocation limit](https://github.com/FFmpeg/FFmpeg/blob/n9.0.1/libavutil/fifo.c#L33)

Each audible edit segment now has independent video and audio inputs, with
identical seek/duration bounds. Video input disables audio; audio input disables
video. This prevents fast audio consumption from filling the video packet queue.
Silent/muted edits still open only one input per segment. Filters, encoder
profiles, bitrate plans, quality settings, and GPU encoding remain unchanged.

The complete 2,173-second edit was rerendered using the same timeline and quality
plan. It produced 130,467 video packets, compared with 59,417 in the faulty file.
Its largest adjacent video timestamp gap was 0.033 seconds; container bitrate
was 5,459,675 bps. Rendering and packet measurement took 286 seconds. The source
and faulty output were preserved; the corrected file was published separately as video 5344 (`recovered-edit-5343.mkv`).

## Acceptance and cancellation

Edits and conversions scan output video packet timestamps before publication or
source replacement. Gaps over one second are mapped to the selected source
intervals, including speed changes, reordered cuts, and nonzero timestamp
origins. Multiple source frames inside a hole cause rejection; pauses already
present in the source remain valid. The corrected real file passed this gate;
the faulty file failed it. Validation took approximately 1.5–1.7 seconds each.

This check detects missing timed packets, not visual corruption or repeated
images encoded as ordinary frames. It also does not compare audio continuity.
Native synthetic tests cover an internal video hole masked by continuous audio,
a healthy file, an existing source pause, and offset source/output timestamps.

Both queues serialize pending Redis claims, enforce worker capacity, and wait
for claims and startup recovery during shutdown. A late claim cannot start an
encoder after shutdown. Duration and metadata probes now have timeouts and
cancellation that kills and reaps the child process before settling. Regression
tests use delayed fake Redis responses and disposable native probe processes.
