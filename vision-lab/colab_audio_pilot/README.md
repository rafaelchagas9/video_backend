# Private audio pilot

Raw recordings, images, video and audio stay on the local machine. Only numerical features and pseudonymous grouping/decision labels go to Colab. The export excludes source paths, original channel names, recording identifiers, review reasons and decoded media. Embeddings can still reveal information; exports should remain private, never public links.

`pipeline.py prepare` freezes saved triage decisions and selects up to 96 proposals across channel/decision strata. It reads database metadata and small completed audio caches; it does not open recordings. `refresh` picks up Claude's completed feature files.

`pipeline.py extract --minutes 60` waits for Claude's audio workers and all other FFmpeg processes to finish. It then loads the already-cached, pinned EmbeddingGemma 2 model locally. Completed audio tracks in data/audio_src on the NVMe SSD are reused when their duration covers the proposal; otherwise extraction uses the original recording after Claude finishes. One low-priority FFmpeg process reads at most 20 seconds at a time, with a 768 MiB address-space limit and 45-second timeout. Two uniform windows per proposal avoid selecting only loud peaks. Waveforms live in RAM; only validated 768-dimensional embeddings and timestamps are cached atomically. Source files and production review data are never modified.

The 60-minute local budget includes waiting; unfinished work resumes from cache. This does not allocate a Colab GPU. `features.json` and `features_with_embeddings.json` are the only uploadable files. Never upload `private_manifest.json`.

`evaluate.py` compares identical cohorts with whole channels held out. Scaling is fitted inside training folds. Keep/skip results measure coarse triage, not the final worth learned from versus answers. A small window pilot is exploratory, not grounds for deleting recordings or promoting a model.

Google's audio API and precision requirements: https://ai.google.dev/gemma/docs/embeddinggemma/multimodal-embeddinggemma-with-sentence-transformers


## Preference round (2026-10-10)

`preference_audio.py prepare --seconds 900` freezes the answered versus round and extracts two bounded uniform 30-second windows per offered cut. `align_preference_preview.py` adds one window containing each exact heard snippet and seeds verified existing outputs; it preserves the initial experiment under `uniform_only/`. Use `.venv-v2` for audio preparation/inference, with `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1` for inference. `preference_audio.py infer --seconds 600` resumes numeric checkpoints; `evaluate` produces separate uniform, heard-preview and combined results. The fixed shipped scorer is reported on each same eligible cohort alongside newly fitted heads. Never substitute a post-choice trimmed duration for input features.

`preference_prosody.py` runs CPU-only eGeMAPSv02 in `.venv-prosody` on the cached heard-preview windows, with a predeclared loudness-removal control. Neither experiment changes saved answers or production scoring. Eight decisive pairs limit inference; ASR coverage rejection is not a transcription-accuracy benchmark. Checkpoints store numerical features, not transcripts. Current audio runs are entirely local; the earlier audio-upload authorization does not make the private manifest uploadable.
