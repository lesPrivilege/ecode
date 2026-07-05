HEAD: af5bd4431d0d199a4cbefcf8300ffb1646c71283

# R2 B-fixed add-on execution log — 2026-07-06

## Scope

B' add-on released automatically after R2-core. Run 9 real DeepSeek packet
sessions:

- packets: G2-R1, G2-E1, G2-D1;
- arm: B with `--context-window 48000`;
- repeats: n=3;
- all runs unset `ECODE_TRUST_PROTOCOL`, `ECODE_SEMANTIC_ANCHOR`, and `ECODE_ANCHOR_ACCEPTANCE`.

Snapshot: `experiments/snapshots/taucode`.
`manifestHash=922aa885e628f69f5174219adc443ad14778f4f1dd7bc3ac120c0c47c0b761ba`.

## Order

| # | Repeat | Packet | Arm | context-window | workspace |
| ---: | ---: | --- | --- | ---: | --- |
| 1 | 1 | G2-E1 | B | 48000 | empty |
| 2 | 1 | G2-R1 | B | 48000 | snapshot |
| 3 | 1 | G2-D1 | B | 48000 | snapshot |
| 4 | 2 | G2-D1 | B | 48000 | snapshot |
| 5 | 2 | G2-E1 | B | 48000 | empty |
| 6 | 2 | G2-R1 | B | 48000 | snapshot |
| 7 | 3 | G2-R1 | B | 48000 | snapshot |
| 8 | 3 | G2-D1 | B | 48000 | snapshot |
| 9 | 3 | G2-E1 | B | 48000 | empty |

## Runs

_Filled during execution._
