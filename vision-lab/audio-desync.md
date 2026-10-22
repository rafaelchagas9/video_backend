# Audio desync in GoondVR captures

Every GoondVR capture started before **2026-10-22 03:26 UTC** may play its audio a constant 0.2–3 s off
the picture (it never drifts). GoondVR zeroed the audio and video tracks separately and threw away
the gap between them, so the true offset can't be recovered from the file. The fixed container
(shared-clock Timeline) went live at that time; captures started afterwards are in sync, which the
reviewer confirmed by listening. Library downloads that GoondVR didn't make were never affected.

`audio_desync.py` holds the rule (`desync_suspect(file_name)`, from the UTC timestamp in GoondVR's
file names) and writes **`audio-desync-recordings.csv`**: one row per recording that has review
decisions or a training snapshot. Each row has the capture time, whether it's a suspect, its
keep/skip counts, how many decisions were marked as desync, and whether it was deleted. Rerun it
after reviewing: `uv run python audio_desync.py`.

## What it affects

- **Frames, hand labels, the shipped probe:** no effect. The picture is fine, and the probe trains on
  hand labels plus `skip_wrong` hard negatives only.
- **Clip-level sound summaries** (audio_features.py → stage2_audio.py, minutes per clip): barely moved.
- **Anything pairing a sound with the frame on screen** (reactions, sound-placed edges, AV fusion):
  wrong by up to 3 s on suspects. Train it on in-sync captures only, or jitter audio ±3 s.
- **Keep/skip as a worth label:** some skips on suspect recordings were really "the desync was
  unbearable", not "the moment was bad". Most were never marked, because no reason for it existed
  until 2026-10-22. The reviewer did keep some desynced moments anyway, so a keep on a suspect is
  a strong positive. Before any model learns worth from skips, weight suspect skips lower or
  check that the result holds without them.
- **Audio of kept clips (reviewer, 2026-10-22):** every recording the reviewer made clips from has
  usable audio, either in sync or off by a barely noticeable amount. Recordings with bad desync
  were deleted, and will keep being deleted. So kept clips can feed sound features, even from
  suspects. The ±3 s caution above is still needed for anything second-precise.

## Markers from 2026-10-22 on

- `skip_desync`: a clip skipped only because of the desync. It isn't a content judgement, and
  `deployed_data.latest_clips()` leaves it out.
- Deleting a recording from review asks why:
  - **Nothing worth keeping:** every clip that wasn't already decided is stored as a skip (`skip_tame` + `discard_nothing`).
  - **Audio out of sync** (`discard_desync`) / **Too short / fragment** (`discard_fragment`): nothing is
    learned from it. Decisions that were already saved get the marker added.

## Deleted before the markers existed

On 2026-10-22 the reviewer deleted 28 unsaved recordings: 6621, 6624, 6625, 6627, 6629, 6739,
6740, 6741, 6742, 6743, 6745, 6747, 6748, 6764, 6766, 6770, 6771, 6772, 6780, 6781, 6782, 6783,
6784, 6785, 6786, 6795, 6796, 6797. About 5–6 of them were deleted for desync and the rest for
mixed reasons. None of them has decisions (snapshots hold frames and detector proposals only), and
they must not be read as "nothing worth keeping".
