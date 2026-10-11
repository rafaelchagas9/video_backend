# Stage 1 completion

CPU-only evaluation used all 441 latest review decisions and recovered all 40 hand-labelled recordings (16,145 valid frames). Raw media was not read. Production was not changed.

At the fixed production threshold of 0.45, five whole-channel folds compare the base recipe with hard negatives mined separately inside each training fold. The hard-negative recipe finds 131/144 known kept clips versus 132/144 for base, while judged proposal precision improves from 40.9% to 43.5%.

On the same 69 reviewed recordings from channels that never trained the shipped probe, the shipped model finds 83/85 keeps in 229 proposals; the candidate recipe finds the same 83/85 in 211 proposals. Precision counting unjudged proposals as skips improves from 38.0% to 42.2%. It passes the stated no-kept-loss/no-more-wrong-detection/at-least-two-point-precision-floor gate. This validates the recipe through held-out predictions, not the final full-data candidate in sample.

`candidate.json` exports the final fresh-hard-negative fit in the backend probe schema. Stage 1 can be promoted after the root workflow verifies current runtime threshold and backend inference parity. Old detections or saved decisions must not be rewritten. `report.json`, `inputs.json` and `frames.npz` provide metrics and pseudonymous snapshot integrity. The old production exporter omits one recoverable hand-labelled recording and 64 valid frames; this candidate restores it.

The kept-clip recall metric compares with prior coarse triage proposals. It does not establish final storage worth or global true recall.
